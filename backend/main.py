"""
Lens Cleaner Backend API
Handles paid auto-select feature with Gemini AI integration
"""

import asyncio
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, EmailStr

from gemini_processor import GeminiProcessor

# Load environment variables
load_dotenv()

# Configuration
DATABASE_PATH = "lens_cleaner.db"
UPLOAD_DIR = Path("uploads")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PRICING_PER_PHOTO = 0.01  # $0.01 per photo

# Ensure upload directory exists
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Lens Cleaner API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic models
class CheckoutRequest(BaseModel):
    email: EmailStr
    photo_count: int


class CheckoutResponse(BaseModel):
    checkout_url: str
    checkout_id: str
    total_cost: float


class JobStatusResponse(BaseModel):
    job_id: str
    status: str  # created, uploaded, processing, completed, failed
    email: str
    photo_count: int
    created_at: str
    completed_at: Optional[str] = None
    results: Optional[dict] = None


# Database initialization
async def init_db():
    """Initialize SQLite database with jobs table"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                photo_count INTEGER NOT NULL,
                total_cost REAL NOT NULL,
                checkout_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'created',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                upload_dir TEXT,
                results_json TEXT
            )
        """
        )
        await db.commit()


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup"""
    await init_db()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {"status": "ok", "service": "Lens Cleaner API"}


@app.post("/v1/api/checkout", response_model=CheckoutResponse)
async def create_checkout(request: CheckoutRequest):
    """
    Create a checkout session for auto-select feature
    Returns a checkout URL for payment
    """
    checkout_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    total_cost = request.photo_count * PRICING_PER_PHOTO

    # Create job in database
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            INSERT INTO jobs (id, email, photo_count, total_cost, checkout_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                request.email,
                request.photo_count,
                total_cost,
                checkout_id,
                "created",
                datetime.now().isoformat(),
            ),
        )
        await db.commit()

    # Create upload directory for this job
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(exist_ok=True)

    # Update job with upload directory
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE jobs SET upload_dir = ? WHERE id = ?", (str(job_upload_dir), job_id)
        )
        await db.commit()

    # Return checkout URL (will redirect back with job_id)
    base_url = os.getenv("API_BASE_URL", "http://localhost:8000")
    checkout_url = f"{base_url}/v1/api/checkout/{checkout_id}"

    return CheckoutResponse(
        checkout_url=checkout_url, checkout_id=checkout_id, total_cost=total_cost
    )


@app.get("/v1/api/checkout/{checkout_id}", response_class=HTMLResponse)
async def mock_checkout_page(checkout_id: str):
    """
    Mock checkout page that simulates payment processing
    Redirects back to the app with job_id
    """
    # Get job by checkout_id
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT id, email, total_cost, photo_count FROM jobs WHERE checkout_id = ?",
            (checkout_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Checkout session not found")

    job_id, email, total_cost, photo_count = row

    # Get the extension URL from environment or use default
    extension_url = os.getenv(
        "EXTENSION_URL", "chrome-extension://your-extension-id/dashboard.html"
    )

    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Lens Cleaner - Checkout</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @keyframes slideIn {{
                from {{
                    opacity: 0;
                    transform: translateY(-20px);
                }}
                to {{
                    opacity: 1;
                    transform: translateY(0);
                }}
            }}
            .animate-slide-in {{
                animation: slideIn 0.5s ease-out;
            }}
        </style>
    </head>
    <body class="bg-gradient-to-br from-purple-100 to-pink-100 min-h-screen flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-2xl border-4 border-black max-w-md w-full p-8 animate-slide-in">
            <div class="text-center mb-6">
                <div class="text-6xl mb-4">🎯</div>
                <h1 class="text-3xl font-black text-black mb-2">Mock Checkout</h1>
                <p class="text-gray-600">Lens Cleaner Auto-Select</p>
            </div>

            <div class="bg-gray-50 rounded-xl border-2 border-black p-6 mb-6">
                <div class="space-y-3">
                    <div class="flex justify-between items-center">
                        <span class="font-semibold text-gray-700">Email:</span>
                        <span class="text-black font-mono text-sm">{email}</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="font-semibold text-gray-700">Photos:</span>
                        <span class="text-black font-bold">{photo_count}</span>
                    </div>
                    <div class="border-t-2 border-gray-300 pt-3 mt-3">
                        <div class="flex justify-between items-center">
                            <span class="font-bold text-lg text-gray-900">Total:</span>
                            <span class="text-2xl font-black text-black">${total_cost:.2f}</span>
                        </div>
                    </div>
                </div>
            </div>

            <button
                onclick="completePayment()"
                id="payButton"
                class="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-black py-4 px-6 rounded-xl border-4 border-black shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all text-lg"
            >
                💳 Complete Payment
            </button>

            <p class="text-center text-sm text-gray-500 mt-4">
                This is a mock payment page for testing
            </p>
        </div>

        <script>
            async function completePayment() {{
                const button = document.getElementById('payButton');
                button.disabled = true;
                button.innerHTML = '⏳ Processing...';
                button.classList.add('opacity-50', 'cursor-not-allowed');

                // Simulate payment processing
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Redirect back to extension with job_id
                const redirectUrl = '{extension_url}?job_id={job_id}&payment=success';
                window.location.href = redirectUrl;
            }}
        </script>
    </body>
    </html>
    """

    return HTMLResponse(content=html_content)


@app.post("/v1/api/job/{job_id}/upload")
async def upload_photo(job_id: str, file: UploadFile = File(...)):
    """
    Upload a single photo for a job (atomic upload)
    Frontend should send photos one at a time with up to 5 concurrent requests
    """
    # Verify job exists
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT upload_dir, status FROM jobs WHERE id = ?", (job_id,)
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    upload_dir, status = row

    if status not in ["created", "uploaded"]:
        raise HTTPException(status_code=400, detail="Job is already processing or completed")

    # Save uploaded file
    upload_path = Path(upload_dir)
    upload_path.mkdir(exist_ok=True)

    file_path = upload_path / file.filename
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Update job status to uploaded (will stay uploaded until processing starts)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE jobs SET status = ? WHERE id = ?", ("uploaded", job_id))
        await db.commit()

    return {"message": "Photo uploaded", "job_id": job_id, "filename": file.filename}


@app.post("/v1/api/job/{job_id}")
async def start_processing(job_id: str, photo_metadata: list[dict] = Body(...)):
    """
    Start processing a job with Gemini AI
    Creates JSONL file and queues for batch processing

    photo_metadata: List of photo metadata including id, filename, group_id
    """
    # Verify job exists and is uploaded
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT upload_dir, status FROM jobs WHERE id = ?", (job_id,)
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    upload_dir, status = row

    if status != "uploaded":
        raise HTTPException(status_code=400, detail="Job must be uploaded before processing")

    # Update status to processing
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE jobs SET status = ? WHERE id = ?", ("processing", job_id))
        await db.commit()

    # Start background processing
    asyncio.create_task(process_job_with_gemini(job_id, upload_dir, photo_metadata))

    return {"message": "Processing started", "job_id": job_id}


@app.get("/v1/api/job/{job_id}")
async def get_job_status(job_id: str):
    """
    Get job status
    Returns 202 if processing, 200 if completed
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            """
            SELECT id, email, photo_count, status, created_at, completed_at, results_json
            FROM jobs WHERE id = ?
            """,
            (job_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    job_id, email, photo_count, status, created_at, completed_at, results_json = row

    response = JobStatusResponse(
        job_id=job_id,
        status=status,
        email=email,
        photo_count=photo_count,
        created_at=created_at,
        completed_at=completed_at,
        results=json.loads(results_json) if results_json else None,
    )

    # Return 202 if still processing, 200 if completed
    if status == "processing":
        return JSONResponse(content=response.model_dump(), status_code=202)
    elif status == "completed":
        return JSONResponse(content=response.model_dump(), status_code=200)
    elif status == "failed":
        return JSONResponse(content=response.model_dump(), status_code=500)
    else:
        return JSONResponse(content=response.model_dump(), status_code=200)


async def process_job_with_gemini(job_id: str, upload_dir: str, photo_metadata: list[dict]):
    """
    Background task to process photos with Gemini AI
    """
    try:
        api_key = GOOGLE_API_KEY

        if not api_key:
            # If no API key, use mock processing
            print(f"No API key found, using mock processing for job {job_id}")
            await asyncio.sleep(10)

            results = {
                "deletions": [
                    {
                        "photo_id": photo_metadata[0]["id"] if photo_metadata else "mock",
                        "reason": "Mock deletion - Blurry image with poor focus",
                        "confidence": "high",
                    }
                ]
            }
        else:
            # Use real Gemini processing
            processor = GeminiProcessor(api_key)
            results = await processor.process_photos(job_id, Path(upload_dir), photo_metadata)

        # Update job as completed
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                """
                UPDATE jobs
                SET status = ?, completed_at = ?, results_json = ?
                WHERE id = ?
                """,
                ("completed", datetime.now().isoformat(), json.dumps(results), job_id),
            )
            await db.commit()

        # Clean up uploaded files
        upload_path = Path(upload_dir)
        for file in upload_path.glob("*"):
            if file.is_file() and file.name != "batch_requests.jsonl":
                file.unlink()

    except Exception as e:
        # Mark job as failed
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                """
                UPDATE jobs
                SET status = ?, completed_at = ?
                WHERE id = ?
                """,
                ("failed", datetime.now().isoformat(), job_id),
            )
            await db.commit()
        print(f"Error processing job {job_id}: {e}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
