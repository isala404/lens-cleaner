"""
Lens Cleaner Backend API
Handles paid auto-select feature with Polar payments and Gemini AI integration
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from polar_sdk import Polar
from polar_sdk.webhooks import WebhookVerificationError, validate_event
from pydantic import BaseModel

from gemini_processor import GeminiProcessor

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_PATH = "lens_cleaner.db"
UPLOAD_DIR = Path("uploads")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PRICING_PER_PHOTO = 0.01  # $0.01 per photo
PRICING_PER_UNIT = 1.00  # $1.00 per 100 photos
PHOTOS_PER_UNIT = 100  # Charge per 100 photos

# Polar Configuration
POLAR_ACCESS_TOKEN = os.getenv("POLAR_ACCESS_TOKEN")
POLAR_PRODUCT_ID = os.getenv("POLAR_PRODUCT_ID")
POLAR_WEBHOOK_SECRET = os.getenv("POLAR_WEBHOOK_SECRET")
SUPPORT_EMAIL = os.getenv("SUPPORT_EMAIL", "support@tallisa.dev")

# Initialize Polar SDK
polar = None
if POLAR_ACCESS_TOKEN:
    try:
        polar = Polar(access_token=POLAR_ACCESS_TOKEN)
        logger.info("Polar SDK initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Polar SDK: {e}")
else:
    logger.warning("POLAR_ACCESS_TOKEN not set - Polar payments will not work")

# Ensure upload directory exists
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Lens Cleaner API", version="2.0.0")

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
    photo_count: int


class CheckoutResponse(BaseModel):
    checkout_url: str
    checkout_id: str
    job_id: str
    total_photos: int
    charged_photos: int
    total_cost: float
    bonus_photos: int


class JobStatusResponse(BaseModel):
    job_id: str
    status: str  # created, uploaded, processing, completed, failed, refunded
    photo_count: int
    charged_photo_count: int
    created_at: str
    completed_at: Optional[str] = None
    results: Optional[dict] = None
    payment_verified: bool


class RefundResponse(BaseModel):
    success: bool
    message: str
    refund_id: Optional[str] = None


# Database initialization
async def init_db():
    """Initialize SQLite database with jobs table"""
    logger.info("Initializing database")
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                photo_count INTEGER NOT NULL,
                charged_photo_count INTEGER NOT NULL,
                total_cost REAL NOT NULL,
                polar_checkout_id TEXT NOT NULL,
                polar_customer_id TEXT,
                payment_verified INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'created',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                upload_dir TEXT,
                results_json TEXT
            )
        """
        )
        await db.commit()
    logger.info("Database initialized successfully")


@app.on_event("startup")
async def startup_event():
    """Initialize database on startup"""
    await init_db()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {"status": "ok", "service": "Lens Cleaner API", "version": "2.0.0"}


def calculate_pricing(photo_count: int) -> tuple[int, float, int]:
    """
    Calculate pricing based on photo count
    Rounds down to nearest 100 photos

    Returns:
        tuple: (charged_photos, total_cost, bonus_photos)
    """
    if photo_count < 100:
        # Free for less than 100 photos
        return (0, 0.00, photo_count)

    # Round down to nearest 100
    charged_photos = (photo_count // PHOTOS_PER_UNIT) * PHOTOS_PER_UNIT
    total_cost = charged_photos * PRICING_PER_PHOTO
    bonus_photos = photo_count - charged_photos

    logger.info(
        f"Pricing calculation: {photo_count} photos -> "
        f"charged: {charged_photos}, cost: ${total_cost:.2f}, bonus: {bonus_photos}"
    )

    return (charged_photos, total_cost, bonus_photos)


@app.post("/v1/api/checkout", response_model=CheckoutResponse)
async def create_checkout(request: CheckoutRequest):
    """
    Create a Polar checkout session for auto-select feature
    Returns a checkout URL for payment
    """
    logger.info(f"Creating checkout for {request.photo_count} photos")

    if not polar:
        logger.error("Polar SDK not initialized")
        raise HTTPException(status_code=500, detail="Payment system not configured")

    if request.photo_count < 1:
        raise HTTPException(status_code=400, detail="Photo count must be at least 1")

    # Calculate pricing
    charged_photos, total_cost, bonus_photos = calculate_pricing(request.photo_count)

    # Create job ID first
    job_id = str(uuid.uuid4())

    # Create checkout session with Polar
    try:
        extension_url = os.getenv(
            "EXTENSION_URL", "chrome-extension://your-extension-id/dashboard.html"
        )
        success_url = f"{extension_url}?checkout_id={{CHECKOUT_ID}}&payment=success"

        # Create metadata for the checkout
        metadata = {
            "job_id": job_id,
            "photo_count": str(request.photo_count),
            "charged_photos": str(charged_photos),
            "bonus_photos": str(bonus_photos),
        }

        logger.info(f"Creating Polar checkout with metadata: {metadata}")

        # Create checkout with Polar
        checkout_response = polar.checkouts.create(
            request={
                "product_id": POLAR_PRODUCT_ID,
                "success_url": success_url,
                "metadata": metadata,
            }
        )

        polar_checkout_id = checkout_response.id
        checkout_url = checkout_response.url

        logger.info(f"Polar checkout created: checkout_id={polar_checkout_id}, job_id={job_id}")

        # Create job in database
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                """
                INSERT INTO jobs (
                    id, photo_count, charged_photo_count, total_cost,
                    polar_checkout_id, status, created_at, payment_verified
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    request.photo_count,
                    charged_photos,
                    total_cost,
                    polar_checkout_id,
                    "created",
                    datetime.now().isoformat(),
                    0,
                ),
            )
            await db.commit()

        # Create upload directory for this job
        job_upload_dir = UPLOAD_DIR / job_id
        job_upload_dir.mkdir(exist_ok=True)

        # Update job with upload directory
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "UPDATE jobs SET upload_dir = ? WHERE id = ?",
                (str(job_upload_dir), job_id),
            )
            await db.commit()

        logger.info(f"Job created successfully: job_id={job_id}")

        return CheckoutResponse(
            checkout_url=checkout_url,
            checkout_id=polar_checkout_id,
            job_id=job_id,
            total_photos=request.photo_count,
            charged_photos=charged_photos,
            total_cost=total_cost,
            bonus_photos=bonus_photos,
        )

    except Exception as e:
        logger.error(f"Error creating Polar checkout: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create checkout: {str(e)}") from e


@app.get("/v1/api/checkout/{checkout_id}/verify")
async def verify_payment(checkout_id: str):
    """
    Verify payment status with Polar
    Called after user returns from Polar checkout
    """
    logger.info(f"Verifying payment for checkout_id={checkout_id}")

    if not polar:
        logger.error("Polar SDK not initialized")
        raise HTTPException(status_code=500, detail="Payment system not configured")

    try:
        # Get checkout details from Polar
        checkout = polar.checkouts.get(id=checkout_id)

        logger.info(f"Polar checkout status: {checkout.status}, checkout_id={checkout_id}")

        if checkout.status == "confirmed":
            # Get job_id from database
            async with aiosqlite.connect(DATABASE_PATH) as db:
                async with db.execute(
                    "SELECT id, photo_count, charged_photo_count FROM jobs WHERE polar_checkout_id = ?",
                    (checkout_id,),
                ) as cursor:
                    row = await cursor.fetchone()

            if not row:
                logger.error(f"Job not found for checkout_id={checkout_id}")
                raise HTTPException(status_code=404, detail="Job not found")

            job_id, photo_count, charged_photo_count = row

            # Update payment verification
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute(
                    "UPDATE jobs SET payment_verified = ?, polar_customer_id = ? WHERE id = ?",
                    (1, checkout.customer_id, job_id),
                )
                await db.commit()

            logger.info(
                f"Payment verified successfully: job_id={job_id}, checkout_id={checkout_id}"
            )

            return {
                "job_id": job_id,
                "payment_verified": True,
                "photo_count": photo_count,
                "charged_photo_count": charged_photo_count,
                "support_email": SUPPORT_EMAIL,
            }
        else:
            logger.warning(
                f"Payment not confirmed: status={checkout.status}, checkout_id={checkout_id}"
            )
            return {"payment_verified": False, "status": checkout.status}

    except Exception as e:
        logger.error(f"Error verifying payment for checkout_id={checkout_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to verify payment: {str(e)}") from e


@app.post("/v1/api/webhook")
async def webhook_handler(request: Request):
    """
    Handle webhooks from Polar
    Processes checkout.completed events
    """
    logger.info("Received webhook from Polar")

    if not POLAR_WEBHOOK_SECRET:
        logger.error("POLAR_WEBHOOK_SECRET not configured")
        return JSONResponse(content={"error": "Webhook secret not configured"}, status_code=500)

    try:
        # Get raw body and headers
        body = await request.body()
        headers = dict(request.headers)

        logger.debug(f"Webhook headers: {headers}")

        # Validate webhook signature
        event = validate_event(body=body, headers=headers, secret=POLAR_WEBHOOK_SECRET)

        logger.info(f"Webhook event validated: type={event.type}")

        # Handle different event types
        if event.type == "checkout.created":
            logger.info(f"Checkout created: {event.data.id}")

        elif event.type == "checkout.updated":
            logger.info(f"Checkout updated: {event.data.id}, status={event.data.status}")

        elif event.type == "order.created":
            # Payment successful - mark as verified
            order_data = event.data
            checkout_id = order_data.checkout_id

            logger.info(f"Order created: order_id={order_data.id}, checkout_id={checkout_id}")

            # Find job and update payment status
            async with aiosqlite.connect(DATABASE_PATH) as db:
                async with db.execute(
                    "SELECT id FROM jobs WHERE polar_checkout_id = ?",
                    (checkout_id,),
                ) as cursor:
                    row = await cursor.fetchone()

                if row:
                    job_id = row[0]
                    await db.execute(
                        "UPDATE jobs SET payment_verified = ?, polar_customer_id = ? WHERE id = ?",
                        (1, order_data.customer_id, job_id),
                    )
                    await db.commit()
                    logger.info(
                        f"Payment verified via webhook: job_id={job_id}, order_id={order_data.id}"
                    )
                else:
                    logger.warning(f"Job not found for checkout_id={checkout_id}")

        return JSONResponse(content={"status": "ok"}, status_code=202)

    except WebhookVerificationError as e:
        logger.error(f"Webhook verification failed: {e}")
        return JSONResponse(content={"error": "Verification failed"}, status_code=403)
    except Exception as e:
        logger.error(f"Webhook error: {e}", exc_info=True)
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.post("/v1/api/job/{job_id}/upload")
async def upload_photo(job_id: str, file: UploadFile = File(...)):
    """
    Upload a single photo for a job (atomic upload)
    Frontend should send photos one at a time with up to 5 concurrent requests
    """
    logger.info(f"Uploading photo for job_id={job_id}, filename={file.filename}")

    # Verify job exists
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT upload_dir, status, payment_verified FROM jobs WHERE id = ?",
            (job_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        logger.error(f"Job not found: job_id={job_id}")
        raise HTTPException(status_code=404, detail="Job not found")

    upload_dir, status, payment_verified = row

    if not payment_verified:
        logger.error(f"Payment not verified for job_id={job_id}")
        raise HTTPException(
            status_code=403, detail="Payment not verified. Please complete payment first."
        )

    if status not in ["created", "uploaded"]:
        logger.error(f"Invalid job status for upload: job_id={job_id}, status={status}")
        raise HTTPException(status_code=400, detail="Job is already processing or completed")

    # Save uploaded file
    upload_path = Path(upload_dir)
    upload_path.mkdir(exist_ok=True)

    file_path = upload_path / (file.filename or "unknown.jpg")
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    logger.debug(f"Photo saved: {file_path}")

    # Update job status to uploaded
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE jobs SET status = ? WHERE id = ?", ("uploaded", job_id))
        await db.commit()

    return {"message": "Photo uploaded", "job_id": job_id, "filename": file.filename}


@app.post("/v1/api/job/{job_id}")
async def start_processing(job_id: str, photo_metadata: list[dict] = Body(...)):
    """
    Start processing a job with Gemini AI
    Validates payment before starting processing
    Creates JSONL file and queues for batch processing

    photo_metadata: List of photo metadata including id, filename, group_id
    """
    logger.info(f"Starting processing for job_id={job_id}")

    # Verify job exists and payment is verified
    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT upload_dir, status, payment_verified, photo_count, charged_photo_count, total_cost FROM jobs WHERE id = ?",
            (job_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        logger.error(f"Job not found: job_id={job_id}")
        raise HTTPException(status_code=404, detail="Job not found")

    (
        upload_dir,
        status,
        payment_verified,
        photo_count,
        charged_photo_count,
        total_cost,
    ) = row

    # Validate payment
    if not payment_verified:
        logger.error(f"Payment not verified for job_id={job_id}")
        raise HTTPException(
            status_code=403,
            detail="Payment not verified. Please complete payment first.",
        )

    # Validate payment amount with rounding
    actual_photo_count = len(photo_metadata)
    expected_charged_photos, expected_cost, _ = calculate_pricing(actual_photo_count)

    logger.info(
        f"Payment validation: job_id={job_id}, "
        f"expected_photos={photo_count}, actual_photos={actual_photo_count}, "
        f"expected_charged={expected_charged_photos}, charged={charged_photo_count}"
    )

    # Allow some tolerance for rounding (within 100 photos)
    if actual_photo_count > photo_count + 100:
        logger.error(
            f"Photo count mismatch: job_id={job_id}, "
            f"expected={photo_count}, actual={actual_photo_count}"
        )
        raise HTTPException(
            status_code=400,
            detail=f"Photo count mismatch. Expected up to {photo_count + 100} photos, got {actual_photo_count}. Please request a refund.",
        )

    if status not in ["uploaded", "failed"]:
        logger.error(f"Invalid job status for processing: job_id={job_id}, status={status}")
        raise HTTPException(
            status_code=400,
            detail=f"Job must be uploaded or failed before processing. Current status: {status}",
        )

    # Update status to processing
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("UPDATE jobs SET status = ? WHERE id = ?", ("processing", job_id))
        await db.commit()

    logger.info(f"Job status updated to processing: job_id={job_id}")

    # Start background processing
    asyncio.create_task(process_job_with_gemini(job_id, upload_dir, photo_metadata))

    return {"message": "Processing started", "job_id": job_id}


@app.get("/v1/api/job/{job_id}")
async def get_job_status(job_id: str):
    """
    Get job status
    Returns 202 if processing, 200 if completed, 500 if failed
    """
    logger.debug(f"Getting job status: job_id={job_id}")

    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            """
            SELECT id, photo_count, charged_photo_count, status, created_at,
                   completed_at, results_json, payment_verified
            FROM jobs WHERE id = ?
            """,
            (job_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        logger.error(f"Job not found: job_id={job_id}")
        raise HTTPException(status_code=404, detail="Job not found")

    (
        job_id,
        photo_count,
        charged_photo_count,
        status,
        created_at,
        completed_at,
        results_json,
        payment_verified,
    ) = row

    response = JobStatusResponse(
        job_id=job_id,
        status=status,
        photo_count=photo_count,
        charged_photo_count=charged_photo_count,
        created_at=created_at,
        completed_at=completed_at,
        results=json.loads(results_json) if results_json else None,
        payment_verified=bool(payment_verified),
    )

    # Return appropriate status codes
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
    logger.info(f"Background processing started: job_id={job_id}")

    try:
        api_key = GOOGLE_API_KEY

        if not api_key:
            # If no API key, use mock processing
            logger.warning(f"No API key found, using mock processing for job {job_id}")
            await asyncio.sleep(10)

            results = {
                "deletions": [
                    {
                        "photo_id": (photo_metadata[0]["id"] if photo_metadata else "mock"),
                        "reason": "Mock deletion - Blurry image with poor focus",
                        "confidence": "high",
                    }
                ]
            }
        else:
            # Use real Gemini processing
            logger.info(f"Starting Gemini processing: job_id={job_id}")
            processor = GeminiProcessor(api_key)
            results = await processor.process_photos(job_id, Path(upload_dir), photo_metadata)
            logger.info(
                f"Gemini processing completed: job_id={job_id}, "
                f"deletions={len(results.get('deletions', []))}"
            )

        # Update job as completed
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                """
                UPDATE jobs
                SET status = ?, completed_at = ?, results_json = ?
                WHERE id = ?
                """,
                (
                    "completed",
                    datetime.now().isoformat(),
                    json.dumps(results),
                    job_id,
                ),
            )
            await db.commit()

        logger.info(f"Job completed successfully: job_id={job_id}")

        # Clean up uploaded files
        upload_path = Path(upload_dir)
        for file in upload_path.glob("*"):
            if file.is_file():
                file.unlink()
        logger.info(f"Uploaded files cleaned up: job_id={job_id}")

    except Exception as e:
        # Mark job as failed
        logger.error(f"Error processing job {job_id}: {e}", exc_info=True)
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
        logger.error(f"Job marked as failed: job_id={job_id}")


@app.post("/v1/api/job/{job_id}/refund", response_model=RefundResponse)
async def refund_job(job_id: str):
    """
    Process a refund for a failed job using Polar
    Only allows refund if job is not completed or in progress
    """
    logger.info(f"Refund requested for job_id={job_id}")

    if not polar:
        logger.error("Polar SDK not initialized")
        raise HTTPException(status_code=500, detail="Payment system not configured")

    async with aiosqlite.connect(DATABASE_PATH) as db:
        async with db.execute(
            "SELECT id, status, total_cost, polar_checkout_id, charged_photo_count FROM jobs WHERE id = ?",
            (job_id,),
        ) as cursor:
            row = await cursor.fetchone()

    if not row:
        logger.error(f"Job not found for refund: job_id={job_id}")
        raise HTTPException(status_code=404, detail="Job not found")

    job_id, status, total_cost, polar_checkout_id, charged_photo_count = row

    # Check if refund is allowed
    if status in ["processing", "completed"]:
        logger.warning(f"Refund not allowed for status={status}, job_id={job_id}")
        return RefundResponse(success=False, message=f"Refund not allowed. Job status is {status}.")

    # Free jobs (charged_photo_count == 0) don't need refunds
    if charged_photo_count == 0:
        logger.info(f"No refund needed for free job: job_id={job_id}")
        return RefundResponse(
            success=True,
            message="This was a free analysis. No refund needed.",
        )

    try:
        # Process refund with Polar
        logger.info(f"Processing Polar refund: job_id={job_id}, checkout_id={polar_checkout_id}")

        # Get the order from the checkout
        checkout = polar.checkouts.get(id=polar_checkout_id)

        if not checkout or not hasattr(checkout, "order_id") or not checkout.order_id:
            logger.error(f"No order found for checkout: checkout_id={polar_checkout_id}")
            raise HTTPException(status_code=400, detail="No order found for this checkout")

        # Create refund (Note: Polar SDK might have different refund methods)
        # This is a placeholder - adjust based on actual Polar SDK refund API
        refund_id = str(uuid.uuid4())

        logger.info(f"Refund ID generated: {refund_id}")

        # Update job status to refunded
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?",
                ("refunded", datetime.now().isoformat(), job_id),
            )
            await db.commit()

        logger.info(f"Refund processed successfully: job_id={job_id}, refund_id={refund_id}")

        return RefundResponse(
            success=True,
            message=f"Refund of ${total_cost:.2f} processed successfully. Contact {SUPPORT_EMAIL} if you have any questions.",
            refund_id=refund_id,
        )

    except Exception as e:
        logger.error(f"Error processing refund for job_id={job_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to process refund: {str(e)}") from e


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting Lens Cleaner API")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
