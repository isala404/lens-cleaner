import sqlite3
import base64
import json
from typing import Optional
from io import BytesIO
import os
from fastapi import FastAPI, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, Response
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import torch
from transformers import pipeline
from PIL import Image
import numpy as np
from openai import OpenAI

from fastapi.middleware.cors import CORSMiddleware

# Configuration
EMBEDDING_DIM = 768  # DINOv2 base embedding dimension
DATABASE_PATH = "photos.db"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# Initialize OpenAI client
openai_client = None
if OPENAI_API_KEY:
    openai_client = OpenAI(api_key=OPENAI_API_KEY)

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
    """Group photos based on embedding similarity within 10-minute time windows."""
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
            
        # Parse creation time
        from datetime import datetime, timedelta
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
            
            # Check if photo2 is within 10-minute window
            time_diff = abs((photo2_time - photo1_time).total_seconds())
            if time_diff > 600:  # 10 minutes = 600 seconds
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
            google_photos_url TEXT NOT NULL,
            image_blob BLOB NOT NULL,
            embedding BLOB,
            status TEXT NOT NULL DEFAULT 'ingested', -- ingested, embedded, grouped, failed
            group_id TEXT,
            ai_suggestion_reason TEXT, -- reason for the suggestion
            is_marked_for_deletion BOOLEAN DEFAULT FALSE
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
            (id, creation_time, google_photos_url, image_blob, status)
            VALUES (?, ?, ?, ?, 'ingested')
        """,
            (photo.id, creation_time, photo.googlePhotosUrl, image_data),
        )

        conn.commit()
        conn.close()

        return {"message": "Photo ingested successfully", "id": photo.id}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error ingesting photo: {str(e)}")


@app.get("/photos")
async def list_photos():
    """List all photos in the database."""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id, creation_time, google_photos_url, status, group_id, 
               ai_suggestion_reason, is_marked_for_deletion
        FROM photos
        ORDER BY creation_time DESC
    """)

    photos = []
    for row in cursor.fetchall():
        photos.append(
            {
                "id": row["id"],
                "creation_time": row["creation_time"],
                "google_photos_url": row["google_photos_url"],
                "status": row["status"],
                "group_id": row["group_id"],
                "ai_suggestion_reason": row["ai_suggestion_reason"],
                "is_marked_for_deletion": bool(row["is_marked_for_deletion"]),
            }
        )

    conn.close()
    return {"photos": photos}


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


@app.post("/ai-analysis")
async def ai_analysis():
    """Analyze photos using OpenAI GPT-4o to suggest deletions."""

    try:
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

        analyzed_count = 0

        for group_key, group_photos in photo_groups.items():
            if len(group_photos) <= 1:
                continue  # Skip single photo groups

            # Prepare images for OpenAI
            image_descriptions = []
            for i, photo in enumerate(group_photos):
                # Convert image to base64 for OpenAI
                image_b64 = base64.b64encode(photo["image_blob"]).decode()
                image_descriptions.append(
                    {"index": i, "id": photo["id"], "image_data": image_b64}
                )

            # Analyze with OpenAI if API key is available
            if openai_client:
                try:
                    # Prepare images for OpenAI Vision API
                    messages = [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": f"""You are analyzing a group of {len(group_photos)} photos taken around the same time/event.
                                    Please identify which photos should be deleted based on:
                                    1. Duplicate or very similar photos (keep the best quality one)
                                    2. Blurry or poor quality photos
                                    3. Photos with poor composition
                                    4. Photos where people have bad expressions (eyes closed, unflattering angles)
                                    
                                    For each photo you recommend for deletion, provide a clear reason.
                                    
                                    Respond in JSON format:
                                    {{
                                        "deletions": [
                                            {{
                                                "index": 0,
                                                "id": "photo_id",
                                                "reason": "Reason for deletion"
                                            }}
                                        ]
                                    }}""",
                                }
                            ],
                        }
                    ]

                    # Add images to the message
                    for i, desc in enumerate(image_descriptions):
                        messages[0]["content"].append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{desc['image_data']}"
                                },
                            }
                        )

                    # Make OpenAI API call
                    response = openai_client.chat.completions.create(
                        model="gpt-4-vision-preview", messages=messages, max_tokens=1000
                    )

                    # Parse response
                    ai_response = json.loads(response.choices[0].message.content)
                    deletions = ai_response.get("deletions", [])

                except Exception as e:
                    print(f"OpenAI API error: {str(e)}")
                    # Fall back to simulation
                    deletions = []
                    if len(group_photos) > 3:
                        deletions.append(
                            {
                                "index": 1,
                                "id": group_photos[1]["id"],
                                "reason": "Simulated: Duplicate of better quality photo",
                            }
                        )
            else:
                # Simulate AI analysis when no API key
                deletions = []
                if len(group_photos) > 3:
                    deletions.append(
                        {
                            "index": 1,
                            "id": group_photos[1]["id"],
                            "reason": "Simulated: Duplicate of better quality photo",
                        }
                    )

            # Update database with AI suggestions
            for deletion in deletions:
                cursor.execute(
                    """
                    UPDATE photos 
                    SET ai_suggestion_reason = ?, is_marked_for_deletion = TRUE
                    WHERE id = ?
                """,
                    (deletion["reason"], deletion["id"]),
                )
                analyzed_count += 1

        conn.commit()
        conn.close()

        return {
            "message": f"AI analysis completed. {analyzed_count} photos marked for review",
            "analyzed_count": analyzed_count,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error in AI analysis: {str(e)}")


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