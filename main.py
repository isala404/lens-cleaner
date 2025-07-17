import sqlite3
import base64
import json
from typing import Optional
from io import BytesIO
import os
import uuid
from datetime import datetime
from fastapi import FastAPI, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, Response
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import torch
from transformers import pipeline
from PIL import Image
import numpy as np
from fastapi.middleware.cors import CORSMiddleware

# Import Gemini client
from google import genai
from google.genai import types

# Configuration
EMBEDDING_DIM = 768  # DINOv2 base embedding dimension
DATABASE_PATH = "photos.db"
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# Batch processing configuration
BATCH_MODEL_ID = "gemini-2.0-flash"
BATCH_DISPLAY_NAME = "photo-analysis-batch"
POLLING_INTERVAL = 30

# Structured Output Schema for batch processing
BATCH_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "analysis": {"type": "STRING"},
        "deletions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "index": {"type": "INTEGER"},
                    "id": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]}
                },
                "required": ["index", "id", "reason", "confidence"]
            }
        }
    },
    "required": ["analysis", "deletions"]
}


gemini_client = None
if GOOGLE_API_KEY:
    gemini_client = genai.Client(api_key=GOOGLE_API_KEY, http_options={'api_version': 'v1alpha'})

app = FastAPI(title="Google Photos Manager", version="1.0.0")

# Allow CORS from all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Templates and static files
templates = Jinja2Templates(directory="templates")
os.makedirs("templates", exist_ok=True)
os.makedirs("static", exist_ok=True)


# Pydantic models
class PhotoIngest(BaseModel):
    id: str
    mediaType: str
    dateTaken: str
    base64: str
    googlePhotosUrl: str


class PhotoResponse(BaseModel):
    id: str
    creation_time: str
    google_photos_url: str
    status: str
    group_id: Optional[str] = None
    ai_suggestion_reason: Optional[str] = None
    is_marked_for_deletion: bool = False


# Global variables for ML model
_embedding_model = None


def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        device = (
            "cuda"
            if torch.cuda.is_available()
            else "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )
        _embedding_model = pipeline(
            "image-feature-extraction",
            model="facebook/dinov2-base",
            device=device,
            pool=True,
            use_fast=True,
        )
    return _embedding_model


def get_photos_with_embeddings():
    """Get all photos that have embeddings calculated."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id, embedding, creation_time, group_id
        FROM photos 
        WHERE embedding IS NOT NULL AND status IN ('embedded', 'grouped')
        ORDER BY creation_time
    """)

    photos = []
    for row in cursor.fetchall():
        embedding = np.frombuffer(row["embedding"], dtype=np.float32)
        photos.append(
            {
                "id": row["id"],
                "embedding": embedding,
                "creation_time": row["creation_time"],
                "group_id": row["group_id"],
            }
        )

    conn.close()
    return photos


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Calculate cosine similarity between two vectors."""
    dot_product = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    return dot_product / (norm_a * norm_b)

def group_similar_photos(threshold: float = 0.6):
    """Group photos based on embedding similarity within 60-minute time windows."""
    photos = get_photos_with_embeddings()
    
    if len(photos) < 2:
        return
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Reset existing groups
    cursor.execute("UPDATE photos SET group_id = NULL WHERE status = 'embedded'")
    
    group_counter = 1
    processed_photos = set()
    
    # Sort photos by creation time
    photos.sort(key=lambda x: x["creation_time"])
    
    for i, photo1 in enumerate(photos):
        if photo1["id"] in processed_photos:
            continue
        try:
            photo1_time = datetime.fromisoformat(photo1["creation_time"].replace('Z', '+00:00'))
        except:
            # Fallback for different datetime formats
            photo1_time = datetime.fromisoformat(photo1["creation_time"])
        
        # Start a new group
        group_id = f"group_{group_counter}"
        similar_photos = [photo1["id"]]
        processed_photos.add(photo1["id"])
        
        # Find similar photos within 10-minute window
        for j, photo2 in enumerate(photos[i+1:], i+1):
            if photo2["id"] in processed_photos:
                continue
            
            # Parse photo2 creation time
            try:
                photo2_time = datetime.fromisoformat(photo2["creation_time"].replace('Z', '+00:00'))
            except:
                photo2_time = datetime.fromisoformat(photo2["creation_time"])
            
            # Check if photo2 is within 60-minute window
            time_diff = abs((photo2_time - photo1_time).total_seconds())
            if time_diff > 3600:  # 60 minutes = 3600 seconds
                # Since photos are sorted by time, we can break early
                # if we've exceeded the time window
                if photo2_time > photo1_time:
                    break
                continue
            
            # Check embedding similarity
            similarity = cosine_similarity(photo1["embedding"], photo2["embedding"])
            if similarity >= threshold:
                similar_photos.append(photo2["id"])
                processed_photos.add(photo2["id"])
        
        # Update group_id for similar photos (only if group has more than 1 photo)
        if len(similar_photos) > 1:
            cursor.execute(
                f"UPDATE photos SET group_id = ?, status = 'grouped' WHERE id IN ({','.join(['?' for _ in similar_photos])})",
                [group_id] + similar_photos
            )
            group_counter += 1
    
    conn.commit()
    conn.close()

@app.post("/group-similar-photos")
async def group_similar_photos_endpoint():
    """Group photos based on embedding similarity."""
    try:
        group_similar_photos()
        return {"message": "Photos grouped successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error grouping photos: {str(e)}")

def init_database():
    """Initialize the SQLite database with required tables."""
    conn = sqlite3.connect(DATABASE_PATH)
    cursor = conn.cursor()

    # Create photos table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY,
            creation_time TEXT,
            media_type TEXT,
            google_photos_url TEXT NOT NULL,
            image_blob BLOB NOT NULL,
            embedding BLOB,
            status TEXT NOT NULL DEFAULT 'ingested', -- ingested, embedded, grouped, failed
            group_id TEXT,
            ai_suggestion_reason TEXT, -- reason for the suggestion
            is_marked_for_deletion BOOLEAN DEFAULT FALSE
        )
    """)

    # Create batch jobs table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS batch_jobs (
            id TEXT PRIMARY KEY,
            job_name TEXT,
            display_name TEXT,
            status TEXT NOT NULL DEFAULT 'created', -- created, uploaded, running, completed, failed, cancelled
            created_at TEXT NOT NULL,
            completed_at TEXT,
            input_file_name TEXT,
            output_file_name TEXT,
            total_requests INTEGER DEFAULT 0,
            processed_requests INTEGER DEFAULT 0,
            error_message TEXT
        )
    """)

    conn.commit()
    conn.close()


def get_db_connection():
    """Get a database connection."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup."""
    init_database()


@app.post("/ingest")
async def ingest_photo(photo: PhotoIngest):
    """Ingest a photo into the database."""
    try:
        # Decode base64 image
        image_data = base64.b64decode(photo.base64)

        # Convert dateTaken to ISO format if needed
        creation_time = photo.dateTaken

        conn = get_db_connection()
        cursor = conn.cursor()

        # Insert photo into database
        cursor.execute(
            """
            INSERT OR REPLACE INTO photos 
            (id, creation_time, google_photos_url, image_blob, status, media_type)
            VALUES (?, ?, ?, ?, 'ingested', ?)
        """,
            (photo.id, creation_time, photo.googlePhotosUrl, image_data, photo.mediaType),
        )

        conn.commit()
        conn.close()

        return {"message": "Photo ingested successfully", "id": photo.id}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error ingesting photo: {str(e)}")


@app.get("/photos")
async def list_photos(page: int = 1, limit: int = 50, group_only: bool = False):
    """List photos with pagination and grouping support."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # For stateless operation, always return all photos to avoid pagination issues with groups
    # Get all photos, groups first (sorted by number), then ungrouped
    cursor.execute("""
        SELECT id, creation_time, google_photos_url, status, group_id, 
               ai_suggestion_reason, is_marked_for_deletion
        FROM photos
        WHERE status != 'deleted'
        ORDER BY 
            CASE WHEN group_id IS NULL THEN 1 ELSE 0 END,
            CASE WHEN group_id IS NOT NULL THEN CAST(REPLACE(group_id, 'group_', '') AS INTEGER) END ASC,
            creation_time ASC
    """)

    photos = []
    for row in cursor.fetchall():
        photos.append({
            "id": row["id"],
            "creation_time": row["creation_time"],
            "google_photos_url": row["google_photos_url"],
            "status": row["status"],
            "group_id": row["group_id"],
            "ai_suggestion_reason": row["ai_suggestion_reason"],
            "is_marked_for_deletion": bool(row["is_marked_for_deletion"]),
        })
    
    # Get stats
    cursor.execute("""
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status IN ('embedded', 'grouped') THEN 1 ELSE 0 END) as processed,
            SUM(CASE WHEN is_marked_for_deletion = 1 THEN 1 ELSE 0 END) as marked_for_deletion,
            SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) as deleted
        FROM photos
    """)
    
    stats = cursor.fetchone()
    conn.close()
    
    # Apply pagination on the frontend to maintain group integrity
    offset = (page - 1) * limit
    paginated_photos = photos[offset:offset + limit] if page > 1 else photos[:limit]
    
    return {
        "photos": paginated_photos,
        "all_photos_count": len(photos),
        "pagination": {
            "page": page,
            "limit": limit,
            "total_count": len(photos),
            "has_next": offset + limit < len(photos)
        },
        "stats": {
            "total": stats["total"],
            "processed": stats["processed"],
            "marked_for_deletion": stats["marked_for_deletion"],
            "deleted": stats["deleted"]
        }
    }


@app.get("/photos/groups")
async def list_photo_groups():
    """Get all groups with their photo counts and summary info."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT 
            group_id,
            COUNT(*) as photo_count,
            SUM(CASE WHEN is_marked_for_deletion = 1 THEN 1 ELSE 0 END) as ai_suggested_deletions,
            MIN(creation_time) as earliest_photo,
            MAX(creation_time) as latest_photo
        FROM photos 
        WHERE group_id IS NOT NULL
        GROUP BY group_id
        ORDER BY CAST(REPLACE(group_id, 'group_', '') AS INTEGER) ASC
    """)
    
    groups = []
    for row in cursor.fetchall():
        groups.append({
            "group_id": row["group_id"],
            "photo_count": row["photo_count"],
            "ai_suggested_deletions": row["ai_suggested_deletions"],
            "earliest_photo": row["earliest_photo"],
            "latest_photo": row["latest_photo"]
        })
    
    conn.close()
    return {"groups": groups}


@app.post("/photos/{photo_id}/mark-deletion")
async def mark_photo_for_deletion(photo_id: str, reason: str = Form(default="User marked")):
    """Mark a photo for deletion."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE photos 
        SET is_marked_for_deletion = TRUE, ai_suggestion_reason = ?
        WHERE id = ?
    """, (reason, photo_id))
    
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Photo not found")
    
    conn.commit()
    conn.close()
    
    return {"message": f"Photo {photo_id} marked for deletion"}


@app.post("/photos/{photo_id}/unmark-deletion")
async def unmark_photo_for_deletion(photo_id: str):
    """Unmark a photo for deletion but preserve AI suggestion."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE photos 
        SET is_marked_for_deletion = FALSE
        WHERE id = ?
    """, (photo_id,))
    
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Photo not found")
    
    conn.commit()
    conn.close()
    
    return {"message": f"Photo {photo_id} unmarked for deletion"}


@app.post("/photos/groups/{group_id}/mark-deletion")
async def mark_group_for_deletion(group_id: str):
    """Mark an entire group for deletion."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE photos 
        SET is_marked_for_deletion = TRUE
        WHERE group_id = ?
    """, (group_id,))
    
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Group not found or no photos in group")
    
    conn.commit()
    conn.close()
    
    return {"message": f"Group {group_id} marked for deletion ({cursor.rowcount} photos)"}


@app.post("/photos/groups/{group_id}/unmark-deletion")
async def unmark_group_for_deletion(group_id: str):
    """Unmark an entire group for deletion but preserve AI suggestions."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE photos 
        SET is_marked_for_deletion = FALSE
        WHERE group_id = ?
    """, (group_id,))
    
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Group not found or no photos in group")
    
    conn.commit()
    conn.close()
    
    return {"message": f"Group {group_id} unmarked for deletion ({cursor.rowcount} photos)"}


@app.post("/photos/groups/{group_id}/reset-to-ai")
async def reset_group_to_ai_suggestions(group_id: str):
    """Reset group markings to only AI suggestions."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE photos 
        SET is_marked_for_deletion = CASE 
            WHEN ai_suggestion_reason IS NOT NULL THEN TRUE
            ELSE FALSE
        END
        WHERE group_id = ?
    """, (group_id,))
    
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Group not found or no photos in group")
    
    conn.commit()
    conn.close()
    
    return {"message": f"Group {group_id} reset to AI suggestions"}


@app.post("/calculate-embeddings")
async def calculate_embeddings():
    """Calculate embeddings for photos that don't have them."""
    try:
        model = get_embedding_model()

        conn = get_db_connection()
        cursor = conn.cursor()

        # Get photos without embeddings
        cursor.execute("""
            SELECT id, image_blob, creation_time, google_photos_url FROM photos 
            WHERE embedding IS NULL AND status = 'ingested'
        """)

        photos = cursor.fetchall()
        processed_count = 0

        for photo in photos:
            try:
                # Load image from blob
                image_data = BytesIO(photo["image_blob"])
                image = Image.open(image_data).convert("RGB")

                # Calculate embedding
                embedding = model(image, return_tensors=True)
                embedding_array = np.array(embedding.reshape(-1))
                embedding_blob = embedding_array.tobytes()

                # Update photo with embedding
                cursor.execute(
                    """
                    UPDATE photos 
                    SET embedding = ?, status = 'embedded'
                    WHERE id = ?
                """,
                    (embedding_blob, photo["id"]),
                )

                processed_count += 1

            except Exception as e:
                # Mark as failed
                cursor.execute(
                    """
                    UPDATE photos 
                    SET status = 'failed'
                    WHERE id = ?
                """,
                    (photo["id"],),
                )
                print(f"Failed to process photo {photo['id']}: {str(e)}")

        conn.commit()
        conn.close()

        return {
            "message": f"Processed {processed_count} photos",
            "processed_count": processed_count,
        }

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error calculating embeddings: {str(e)}"
        )


def create_batch_jsonl_for_groups():
    """Create JSONL file with photo groups for Gemini batch processing."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # Get photos with embeddings, prioritizing similarity groups over date groups
    cursor.execute("""
        SELECT id, creation_time, image_blob, group_id,
               DATE(creation_time) as date_group
        FROM photos 
        WHERE status IN ('embedded', 'grouped')
        ORDER BY creation_time
    """)

    photos = cursor.fetchall()

    # Group photos by similarity group_id first, then by date for ungrouped photos
    photo_groups = {}
    for photo in photos:
        # Use group_id if available (similarity-based), otherwise use date
        group_key = (
            photo["group_id"]
            if photo["group_id"]
            else f"date_{photo['date_group']}"
        )
        if group_key not in photo_groups:
            photo_groups[group_key] = []
        photo_groups[group_key].append(photo)

    # Create JSONL requests for groups with multiple photos
    requests_data = []
    request_counter = 1
    
    for group_key, group_photos in photo_groups.items():
        if len(group_photos) <= 1:
            continue  # Skip single photo groups

        # Prepare photo references with base64 data
        photo_refs = []
        for i, photo in enumerate(group_photos):
            # Convert image blob to base64
            image_b64 = base64.b64encode(photo["image_blob"]).decode('utf-8')
            photo_refs.append({
                "index": i,
                "id": photo["id"],
                "base64_data": image_b64,
                "mime_type": "image/jpeg",
                "group_id": photo["group_id"]
            })

        if not photo_refs:
            continue

        # Create the detailed system prompt
        system_prompt = """You are an expert photo curator and digital asset manager with years of experience in identifying valuable photos versus redundant or low-quality images. Your task is to analyze groups of photos taken around the same time and identify which photos should be marked for deletion.

EVALUATION CRITERIA:

1. DUPLICATES & SIMILARITY:
   - Identify photos that are essentially the same shot (same pose, angle, composition)
   - Keep the best quality version (sharpest, best exposure, best composition)
   - Consider slight variations in pose/expression - keep the best one

2. TECHNICAL QUALITY:
   - Mark blurry, out-of-focus, or motion-blurred photos for deletion
   - Identify photos with poor exposure (too dark, too bright, blown highlights)
   - Flag photos with poor composition (subject cut off, tilted horizon, etc.)

3. ARTISTIC & EMOTIONAL VALUE:
   - Preserve photos with unique artistic merit (interesting angles, lighting, composition)
   - Keep photos capturing genuine emotions or special moments
   - Preserve photos that tell a story or capture a unique perspective
   - Consider historical/documentary value for family memories

4. HUMAN ELEMENTS:
   - Delete photos where people have their eyes closed, unflattering expressions
   - Keep photos with natural, genuine expressions and good poses
   - Consider group dynamics - prefer photos where everyone looks good

5. SPECIAL CONSIDERATIONS:
   - Test shots, accidental photos, finger-over-lens should be deleted
   - Screenshots, memes, or non-personal content can usually be deleted
   - Photos of text/documents - keep only if they have ongoing value
   - Landscape/travel photos - preserve unique views, delete redundant angles

DECISION FRAMEWORK:
- If photos are very similar, keep only the best 1-2 versions
- If a photo has ANY unique value (emotional, artistic, documentary), preserve it
- When in doubt between two similar photos, preserve both rather than risk losing memories
- Only mark photos for deletion if they are clearly redundant or have significant quality issues

Be conservative - it's better to keep a questionable photo than to lose an irreplaceable memory.

Always start the analysis with 'In Group <group_id>,'"""

        # Create content parts with text and images
        content_parts = [{"text": system_prompt}]
        
        # Add images to the content using inline base64 data
        for photo_ref in photo_refs:
            content_parts.append({
                "text": f"Photo id: {photo_ref['id']}, index: {photo_ref['index']}, group_id: {photo_ref['group_id']}"
            })
            content_parts.append({
                "inline_data": {
                    "mime_type": photo_ref["mime_type"],
                    "data": photo_ref["base64_data"]
                }
            })
        
        # Add final instruction
        content_parts.append({
            "text": f"Please analyze this group of {len(photo_refs)} photos and identify which ones should be marked for deletion based on the criteria above."
        })

        # Create the request with structured output schema
        request_data = {
            "request": {
                "contents": [{"parts": content_parts}],
                "generation_config": {
                    "temperature": 0.1,
                    "max_output_tokens": 4096,
                    "responseMimeType": "application/json",
                    "responseSchema": BATCH_RESPONSE_SCHEMA
                }
            }
        }
        
        requests_data.append(request_data)
        request_counter += 1

    conn.close()
    return requests_data


@app.post("/create-batch-jsonl")
async def create_batch_jsonl():
    """1. Create JSONL file with photo groups for Gemini batch processing."""
    try:
        # Create JSONL data
        requests_data = create_batch_jsonl_for_groups()
        
        if not requests_data:
            raise HTTPException(status_code=400, detail="No photo groups found for processing")

        # Save JSONL file
        batch_id = str(uuid.uuid4())
        json_file_path = f'batch_requests_{batch_id}.jsonl'
        
        with open(json_file_path, 'w') as f:
            for req in requests_data:
                f.write(json.dumps(req) + '\n')

        # Save batch job metadata to database
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO batch_jobs 
            (id, job_name, display_name, status, created_at, total_requests)
            VALUES (?, ?, ?, 'created', ?, ?)
        """, (
            batch_id,
            '',  # Will be updated when job is created
            f'photo-analysis-{batch_id}',
            datetime.now().isoformat(),
            len(requests_data)
        ))
        
        conn.commit()
        conn.close()

        return {
            "message": f"JSONL file created successfully with {len(requests_data)} requests",
            "batch_id": batch_id,
            "json_file_path": json_file_path,
            "total_requests": len(requests_data)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating JSONL file: {str(e)}")


@app.post("/upload-batch-jsonl")
async def upload_batch_jsonl(batch_id: str = Form(...)):
    """2. Upload the JSONL file to Gemini Files API."""
    if not gemini_client:
        raise HTTPException(status_code=400, detail="Google API key not configured")
    
    try:
        json_file_path = f'batch_requests_{batch_id}.jsonl'
        
        if not os.path.exists(json_file_path):
            raise HTTPException(status_code=404, detail="JSONL file not found")

        # Upload to Gemini Files API
        uploaded_batch_file = gemini_client.files.upload(
            file=json_file_path,
            config=types.UploadFileConfig(
                display_name=f'batch-photo-analysis-{batch_id}',
                mime_type='application/jsonl'
            )
        )

        # Update database with uploaded file info
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("""
            UPDATE batch_jobs 
            SET input_file_name = ?, status = 'uploaded'
            WHERE id = ?
        """, (uploaded_batch_file.name, batch_id))
        
        conn.commit()
        conn.close()

        return {
            "message": "JSONL file uploaded successfully",
            "batch_id": batch_id,
            "uploaded_file": uploaded_batch_file.name
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error uploading JSONL file: {str(e)}")


@app.post("/start-batch-processing")
async def start_batch_processing(batch_id: str = Form(...)):
    """3. Create and start the Gemini batch job."""
    if not gemini_client:
        raise HTTPException(status_code=400, detail="Google API key not configured")
    
    try:
        # Get batch job info from database
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT input_file_name, display_name FROM batch_jobs 
            WHERE id = ? AND status = 'uploaded'
        """, (batch_id,))
        
        job_info = cursor.fetchone()
        if not job_info:
            raise HTTPException(status_code=404, detail="Batch job not found or not uploaded")

        # Create batch job
        batch_job = gemini_client.batches.create(
            model=BATCH_MODEL_ID,
            src=job_info["input_file_name"],
            config=types.CreateBatchJobConfig(display_name=job_info["display_name"])
        )

        # Update database with job info
        cursor.execute("""
            UPDATE batch_jobs 
            SET job_name = ?, status = 'running'
            WHERE id = ?
        """, (batch_job.name, batch_id))
        
        conn.commit()
        conn.close()

        return {
            "message": "Batch processing started successfully",
            "batch_id": batch_id,
            "job_name": batch_job.name
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error starting batch processing: {str(e)}")


@app.post("/check-batch-status")
async def check_batch_status():
    """4. Check status of batch jobs and process completed results."""
    if not gemini_client:
        raise HTTPException(status_code=400, detail="Google API key not configured")
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get running batch jobs
        cursor.execute("""
            SELECT id, job_name, display_name FROM batch_jobs 
            ORDER BY created_at DESC
        """)
        
        jobs = cursor.fetchall()
        processed_jobs = 0
        completed_jobs = 0
        
        for job_row in jobs:
            batch_id = job_row["id"]
            job_name = job_row["job_name"]
            
            try:
                # Check job status
                batch_job = gemini_client.batches.get(name=job_name)
                
                # Update job status - fix the pending/running issue
                status_mapping = {
                    'JOB_STATE_PENDING': 'running',  # Google reports pending while processing, show as running
                    'JOB_STATE_RUNNING': 'running', 
                    'JOB_STATE_SUCCEEDED': 'completed',
                    'JOB_STATE_FAILED': 'failed',
                    'JOB_STATE_CANCELLED': 'cancelled'
                }
                new_status = status_mapping.get(batch_job.state.name, 'unknown')
                
                # Only update status if it's not already set to 'running' to prevent going backwards
                cursor.execute("""
                    SELECT status FROM batch_jobs WHERE id = ?
                """, (batch_id,))
                current_status = cursor.fetchone()["status"]
                
                # Don't downgrade from running to pending
                if not (current_status == 'running' and new_status == 'pending'):
                    cursor.execute("""
                        UPDATE batch_jobs 
                        SET status = ? 
                        WHERE id = ?
                    """, (new_status, batch_id))
                
                if batch_job.state.name == 'JOB_STATE_SUCCEEDED':
                    # Process results
                    result_file_name = batch_job.dest.file_name
                    
                    cursor.execute("""
                        UPDATE batch_jobs 
                        SET output_file_name = ?, completed_at = ?
                        WHERE id = ?
                    """, (result_file_name, datetime.now().isoformat(), batch_id))
                    
                    # Download and save results to disk
                    file_content_bytes = gemini_client.files.download(file=result_file_name)
                    results_file_path = f'batch_results_{batch_id}.jsonl'
                    
                    with open(results_file_path, 'wb') as f:
                        f.write(file_content_bytes)
                    
                    # Parse and update database
                    file_content = file_content_bytes.decode('utf-8')
                    processed_count = 0
                    
                    # import json


                    # skipped = 0
                    # processed = 0
                    # with open('batch_results_ec78707e-7155-432b-ac40-f7bdb915144c.jsonl', 'r') as f:
                    #     for line in f:
                    #         try:
                    #             data = json.loads(line)
                    #             result = json.loads(data['response']['candidates'][0]['content']['parts'][0]['text'])
                    #             print("Total deletions: ", len(result['deletions']))
                    #             processed += 1
                    #         except Exception as e:
                    #             skipped += 1
                    #             print("skipping")
                    #     print("Processed: ", processed)
                    #     print("Skipped: ", skipped)

                    for line in file_content.splitlines():
                        if line:
                            try:
                                parsed_response = json.loads(line)
                                
                                # Extract response content from structured output
                                if 'response' in parsed_response and 'candidates' in parsed_response['response']:
                                    candidate = parsed_response['response']['candidates'][0]

                                    if candidate['finishReason'] == "MAX_TOKENS":
                                        continue
                                    
                                    response_content = candidate['content']
                                    
                                    # For structured output, the response is already JSON
                                    if 'parts' in response_content and len(response_content['parts']) > 0:
                                        response_text = response_content['parts'][0]['text']
                                        
                                        # Parse the JSON response from Gemini
                                        ai_response = json.loads(response_text)
                                        deletions = ai_response.get("deletions", [])
                                        
                                        # Update database with deletion suggestions
                                        for deletion in deletions:
                                            cursor.execute("""
                                                UPDATE photos 
                                                SET ai_suggestion_reason = ?, is_marked_for_deletion = TRUE
                                                WHERE id = ?
                                            """, (deletion["reason"], deletion["id"]))
                                            processed_count += 1
                                        
                            except (json.JSONDecodeError, KeyError) as e:
                                print(f"Error parsing batch result: {e}")
                                continue
                    
                    cursor.execute("""
                        UPDATE batch_jobs 
                        SET processed_requests = ?
                        WHERE id = ?
                    """, (processed_count, batch_id))
                    
                    completed_jobs += 1
                    
                elif batch_job.state.name == 'JOB_STATE_FAILED':
                    error_msg = getattr(batch_job, 'error', 'Unknown error')
                    cursor.execute("""
                        UPDATE batch_jobs 
                        SET error_message = ?, completed_at = ?
                        WHERE id = ?
                    """, (str(error_msg), datetime.now().isoformat(), batch_id))
                    
                processed_jobs += 1
                    
            except Exception as e:
                print(f"Error processing job {job_name}: {e}")
                continue
        
        conn.commit()
        conn.close()
        
        return {
            "message": f"Checked {processed_jobs} batch jobs, {completed_jobs} completed and processed",
            "checked_jobs": processed_jobs,
            "completed_jobs": completed_jobs
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error checking batch status: {str(e)}")


@app.get("/batch-jobs")
async def list_batch_jobs():
    """List all batch jobs."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT id, job_name, display_name, status, created_at, completed_at,
               total_requests, processed_requests, error_message
        FROM batch_jobs
        ORDER BY created_at DESC
    """)
    
    jobs = []
    for row in cursor.fetchall():
        jobs.append({
            "id": row["id"],
            "job_name": row["job_name"],
            "display_name": row["display_name"],
            "status": row["status"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
            "total_requests": row["total_requests"],
            "processed_requests": row["processed_requests"],
            "error_message": row["error_message"]
        })
    
    conn.close()
    return {"jobs": jobs}


@app.delete("/batch-jobs/{batch_id}")
async def delete_batch_job(batch_id: str):
    """Delete a batch job and clean up associated files."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get batch job info before deletion
        cursor.execute("""
            SELECT job_name, input_file_name, output_file_name, status
            FROM batch_jobs 
            WHERE id = ?
        """, (batch_id,))
        
        job_info = cursor.fetchone()
        if not job_info:
            raise HTTPException(status_code=404, detail="Batch job not found")
        
        # Cancel the job if it's still running
        if job_info["status"] in ["running", "pending"] and job_info["job_name"] and gemini_client:
            try:
                gemini_client.batches.cancel(name=job_info["job_name"])
            except Exception as e:
                print(f"Warning: Could not cancel batch job {job_info['job_name']}: {e}")
        
        # Clean up local result files
        results_file_path = f'batch_results_{batch_id}.jsonl'
        if os.path.exists(results_file_path):
            os.remove(results_file_path)
        
        # Clean up any remaining input files
        input_file_path = f'batch_requests_{batch_id}.jsonl'
        if os.path.exists(input_file_path):
            os.remove(input_file_path)
        
        # Delete from database
        cursor.execute("DELETE FROM batch_jobs WHERE id = ?", (batch_id,))
        
        conn.commit()
        conn.close()
        
        return {
            "message": f"Batch job {batch_id} deleted successfully",
            "batch_id": batch_id
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting batch job: {str(e)}")


@app.get("/batch-jobs/latest")
async def get_latest_batch_job():
    """Get the latest batch job."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT id, job_name, display_name, status, created_at, completed_at,
               total_requests, processed_requests, error_message
        FROM batch_jobs
        ORDER BY created_at DESC
        LIMIT 1
    """)
    
    job = cursor.fetchone()
    if not job:
        return {"job": None}
    
    job_data = {
        "id": job["id"],
        "job_name": job["job_name"],
        "display_name": job["display_name"],
        "status": job["status"],
        "created_at": job["created_at"],
        "completed_at": job["completed_at"],
        "total_requests": job["total_requests"],
        "processed_requests": job["processed_requests"],
        "error_message": job["error_message"]
    }
    
    conn.close()
    return {"job": job_data}


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard to view photos."""
    return templates.TemplateResponse("dashboard.html", {"request": request})


@app.get("/photo/{photo_id}")
async def get_photo_image(photo_id: str):
    """Get photo image by ID."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT image_blob FROM photos WHERE id = ?", (photo_id,))
    photo = cursor.fetchone()

    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    conn.close()

    return Response(
        content=photo["image_blob"],
        media_type="image/jpeg",
        headers={"Cache-Control": "max-age=3600"},
    )


@app.post("/review/{photo_id}")
async def review_photo(photo_id: str, action: str = Form(...)):
    """Review AI suggestion - approve or reject deletion."""
    if action not in ["approve", "reject"]:
        raise HTTPException(
            status_code=400, detail="Action must be 'approve' or 'reject'"
        )

    conn = get_db_connection()
    cursor = conn.cursor()

    if action == "approve":
        # Mark for actual deletion
        cursor.execute(
            """
            UPDATE photos 
            SET status = 'deleted'
            WHERE id = ?
        """,
            (photo_id,),
        )
    else:
        # Reject AI suggestion
        cursor.execute(
            """
            UPDATE photos 
            SET is_marked_for_deletion = FALSE, ai_suggestion_reason = NULL
            WHERE id = ?
        """,
            (photo_id,),
        )

    conn.commit()
    conn.close()

    return {"message": f"Photo {photo_id} {action}d successfully"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)