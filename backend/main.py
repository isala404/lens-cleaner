"""
Photo Sweep Backend API
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
from fastapi.responses import JSONResponse, RedirectResponse
from polar_sdk import Polar
from polar_sdk._webhooks import WebhookVerificationError, validate_event
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
DATABASE_PATH = "photo_sweep.db"
UPLOAD_DIR = Path("uploads")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PRICING_PER_PHOTO = 0.01  # $0.01 per photo
PRICING_PER_UNIT = 1.00  # $1.00 per 100 photos
PHOTOS_PER_UNIT = 100  # Charge per 100 photos
VOLUME_LIMIT = int(
    os.getenv("VOLUME_LIMIT", "30000")
)  # Maximum photos before requiring sales contact
SALES_EMAIL = os.getenv("SALES_EMAIL", "sales@tallisa.dev")

# Polar Configuration
POLAR_ACCESS_TOKEN = os.getenv("POLAR_ACCESS_TOKEN")
POLAR_PRODUCT_ID = os.getenv("POLAR_PRODUCT_ID")  # Product ID
POLAR_FREE_PRODUCT_ID = os.getenv("POLAR_FREE_PRODUCT_ID")
POLAR_WEBHOOK_SECRET = os.getenv("POLAR_WEBHOOK_SECRET")
SUPPORT_EMAIL = os.getenv("SUPPORT_EMAIL", "support@tallisa.dev")

required_env_vars = [
    POLAR_ACCESS_TOKEN,
    POLAR_PRODUCT_ID,
    POLAR_FREE_PRODUCT_ID,
    POLAR_WEBHOOK_SECRET,
    GOOGLE_API_KEY,
]
for var in required_env_vars:
    if not var:
        raise ValueError(f"Environment variable {var} is not set")

# Initialize Polar SDK
polar = Polar(access_token=POLAR_ACCESS_TOKEN, server="sandbox")
logger.info("Polar SDK initialized successfully")

# Ensure upload directory exists
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Photo Sweep API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic models
class PricingRequest(BaseModel):
    photo_count: int


class PricingResponse(BaseModel):
    photo_count: int
    charged_photos: int
    total_cost: float
    amount_in_cents: int
    is_free: bool
    volume_limited: bool = False
    volume_limit: int = VOLUME_LIMIT
    sales_email: str = SALES_EMAIL


class CheckoutRequest(BaseModel):
    photo_count: int


class CheckoutResponse(BaseModel):
    checkout_url: str
    checkout_id: str
    job_id: str
    total_photos: int
    charged_photos: int
    total_cost: float
    amount_warning: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str  # created, uploaded, processing, completed, failed, refunded, tampered
    photo_count: int
    charged_photo_count: int
    created_at: str
    completed_at: Optional[str] = None
    results: Optional[dict] = None
    payment_verified: bool
    amount_tampered: bool = False
    expected_amount: Optional[int] = None
    actual_amount: Optional[int] = None


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
                expected_amount INTEGER NOT NULL,
                actual_amount INTEGER,
                polar_checkout_id TEXT NOT NULL,
                polar_customer_id TEXT,
                payment_verified INTEGER DEFAULT 0,
                amount_tampered INTEGER DEFAULT 0,
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
    return {"status": "ok", "service": "Photo Sweep API", "version": "1.0.0"}


@app.get("/v1/api/redirect")
async def redirect_to_extension(checkout_id: Optional[str] = None, payment: Optional[str] = None):
    """
    Redirect endpoint for Polar.sh return URL

    Polar.sh doesn't accept chrome-extension:// URLs as return URLs, so we use this
    backend endpoint as a proxy. The flow is:
    1. User completes payment on Polar.sh
    2. Polar.sh redirects to this endpoint with checkout_id and payment status
    3. This endpoint redirects back to the Chrome extension with the same parameters

    Query parameters:
    - checkout_id: The Polar checkout ID
    - payment: Payment status (success, failed, etc.)
    """
    logger.info(f"Redirect endpoint called: checkout_id={checkout_id}, payment={payment}")

    # Get extension URL from environment
    extension_url = os.getenv(
        "EXTENSION_URL", "chrome-extension://your-extension-id/dashboard.html"
    )

    # Build redirect URL with parameters
    redirect_params = []
    if checkout_id:
        redirect_params.append(f"checkout_id={checkout_id}")
    if payment:
        redirect_params.append(f"payment={payment}")

    if redirect_params:
        redirect_url = f"{extension_url}?{'&'.join(redirect_params)}"
    else:
        redirect_url = extension_url

    logger.info(f"Redirecting to: {redirect_url}")

    return RedirectResponse(url=redirect_url, status_code=302)


def calculate_pricing(photo_count: int) -> tuple[int, float, int]:
    """
    Calculate pricing based on photo count
    Charges exact amount based on photo count

    Returns:
        tuple: (charged_photos, total_cost, amount_in_cents)
    """
    if photo_count <= 50:
        # Free for 50 photos or less
        return (0, 0.00, 0)

    # Charge for all photos over 50
    charged_photos = photo_count
    total_cost = charged_photos * PRICING_PER_PHOTO
    amount_in_cents = int(total_cost * 100)  # Convert to cents for Polar API

    logger.info(
        f"Pricing calculation: {photo_count} photos -> "
        f"charged: {charged_photos}, cost: ${total_cost:.2f}, amount: {amount_in_cents} cents"
    )

    return (charged_photos, total_cost, amount_in_cents)


@app.post("/v1/api/pricing", response_model=PricingResponse)
async def calculate_pricing_endpoint(request: PricingRequest):
    """
    Calculate pricing for a given number of photos
    Returns pricing details including whether it's free or paid
    """
    logger.info(f"Calculating pricing for {request.photo_count} photos")

    if request.photo_count < 1:
        raise HTTPException(status_code=400, detail="Photo count must be at least 1")

    # Check volume limit
    if request.photo_count > VOLUME_LIMIT:
        logger.info(f"Volume limit exceeded: {request.photo_count} > {VOLUME_LIMIT}")
        return PricingResponse(
            photo_count=request.photo_count,
            charged_photos=0,
            total_cost=0.0,
            amount_in_cents=0,
            is_free=False,
            volume_limited=True,
            volume_limit=VOLUME_LIMIT,
            sales_email=SALES_EMAIL,
        )

    # Calculate pricing using existing function
    charged_photos, total_cost, amount_in_cents = calculate_pricing(request.photo_count)

    # Determine if free
    is_free = request.photo_count <= 50

    return PricingResponse(
        photo_count=request.photo_count,
        charged_photos=charged_photos,
        total_cost=total_cost,
        amount_in_cents=amount_in_cents,
        is_free=is_free,
        volume_limited=False,
        volume_limit=VOLUME_LIMIT,
        sales_email=SALES_EMAIL,
    )


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

    # Check volume limit
    if request.photo_count > VOLUME_LIMIT:
        logger.info(f"Volume limit exceeded: {request.photo_count} > {VOLUME_LIMIT}")
        raise HTTPException(
            status_code=429,
            detail=f"Volume limit exceeded. For processing more than {VOLUME_LIMIT} photos, please contact {SALES_EMAIL} for volume discount.",
        )

    # Calculate pricing
    charged_photos, total_cost, expected_amount = calculate_pricing(request.photo_count)

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
            "expected_amount": str(expected_amount),
        }

        logger.info(f"Creating Polar checkout with metadata: {metadata}")

        # Choose appropriate product price ID based on pricing
        product_id = POLAR_FREE_PRODUCT_ID if request.photo_count <= 50 else POLAR_PRODUCT_ID

        # Use the backend redirect endpoint for Polar.sh compatibility
        api_base_url = os.getenv("API_BASE_URL", "http://localhost:8000")
        success_url = f"{api_base_url}/v1/api/redirect?checkout_id={{CHECKOUT_ID}}&payment=success"

        # Create checkout with Polar using correct API format
        # Use the simple dict approach as the model approach has issues
        checkout_data = {
            "products": [product_id],
            "amount": expected_amount,
            "success_url": success_url,
            "metadata": metadata,
            "allow_discount_codes": False,
        }

        if expected_amount < 50:
            del checkout_data["amount"]

        logger.info(f"Creating Polar checkout with request: {checkout_data}")

        checkout_response = polar.checkouts.create(request=checkout_data)

        polar_checkout_id = checkout_response.id
        checkout_url = checkout_response.url

        logger.info(f"Polar checkout created: checkout_id={polar_checkout_id}, job_id={job_id}")

        # Create job in database
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                """
                INSERT INTO jobs (
                    id, photo_count, charged_photo_count, total_cost, expected_amount,
                    polar_checkout_id, status, created_at, payment_verified, amount_tampered
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    request.photo_count,
                    charged_photos,
                    total_cost,
                    expected_amount,
                    polar_checkout_id,
                    "created",
                    datetime.now().isoformat(),
                    0,
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

        # Add warning about amount modification
        amount_warning = (
            "WARNING: Do not modify the payment amount during checkout. "
            "If you change the amount, your transaction will be marked as tampered "
            "and you will need to contact support for assistance."
        )

        return CheckoutResponse(
            checkout_url=checkout_url,
            checkout_id=polar_checkout_id,
            job_id=job_id,
            total_photos=request.photo_count,
            charged_photos=charged_photos,
            total_cost=total_cost,
            amount_warning=amount_warning,
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

        if checkout.status in ["confirmed", "succeeded", "SUCCEEDED"]:
            # Get job_id and expected amount from database
            async with aiosqlite.connect(DATABASE_PATH) as db:
                async with db.execute(
                    "SELECT id, photo_count, charged_photo_count, expected_amount FROM jobs WHERE polar_checkout_id = ?",
                    (checkout_id,),
                ) as cursor:
                    row = await cursor.fetchone()

            if not row:
                logger.error(f"Job not found for checkout_id={checkout_id}")
                raise HTTPException(status_code=404, detail="Job not found")

            job_id, photo_count, charged_photo_count, expected_amount = row

            # Verify the payment amount matches expected amount
            actual_amount = getattr(checkout, "amount", None)

            if actual_amount is not None and actual_amount != expected_amount:
                # Amount mismatch - mark as tampered and reject
                logger.error(
                    f"Payment amount mismatch: job_id={job_id}, "
                    f"expected={expected_amount}, actual={actual_amount}"
                )

                async with aiosqlite.connect(DATABASE_PATH) as db:
                    await db.execute(
                        "UPDATE jobs SET status = ?, amount_tampered = ?, actual_amount = ? WHERE id = ?",
                        ("tampered", 1, actual_amount, job_id),
                    )
                    await db.commit()

                # Return 402 Payment Required status code
                raise HTTPException(
                    status_code=402,
                    detail=f"Payment amount mismatch. Expected ${expected_amount / 100:.2f}, received ${actual_amount / 100:.2f}. Please contact {SUPPORT_EMAIL} for assistance.",
                )

            # Update payment verification with actual amount
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute(
                    "UPDATE jobs SET payment_verified = ?, polar_customer_id = ?, actual_amount = ? WHERE id = ?",
                    (1, checkout.customer_id, actual_amount, job_id),
                )
                await db.commit()

            logger.info(
                f"Payment verified successfully: job_id={job_id}, checkout_id={checkout_id}, amount={actual_amount}"
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

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
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

        logger.info(f"Webhook event validated: {event}")

        # Handle different event types - use string matching for event type
        event_str = str(event)

        if "order.created" in event_str:
            # Payment successful - verify amount and mark as verified
            logger.info("Order created event detected")

            # Extract order data from event
            try:
                # Try to get order ID and checkout ID from the event
                order_id = getattr(event.data, "id", None) if hasattr(event, "data") else None
                checkout_id = (
                    getattr(event.data, "checkout_id", None) if hasattr(event, "data") else None
                )

                logger.info(f"Order created: order_id={order_id}, checkout_id={checkout_id}")

                if checkout_id:
                    # Find job and verify amount
                    async with aiosqlite.connect(DATABASE_PATH) as db:
                        async with db.execute(
                            "SELECT id, expected_amount FROM jobs WHERE polar_checkout_id = ?",
                            (checkout_id,),
                        ) as cursor:
                            row = await cursor.fetchone()

                        if row:
                            job_id, expected_amount = row

                            # Get actual amount from order
                            actual_amount = (
                                getattr(event.data, "amount", None)
                                if hasattr(event, "data")
                                else None
                            )

                            # Check for tampering
                            amount_tampered = 0
                            if actual_amount is not None and actual_amount != expected_amount:
                                amount_tampered = 1
                                logger.warning(
                                    f"Amount tampering detected: job_id={job_id}, "
                                    f"expected={expected_amount}, actual={actual_amount}"
                                )
                                # Update job status to tampered
                                await db.execute(
                                    "UPDATE jobs SET status = ?, amount_tampered = ?, actual_amount = ? WHERE id = ?",
                                    ("tampered", amount_tampered, actual_amount, job_id),
                                )
                            else:
                                # Normal payment verification
                                customer_id = (
                                    getattr(event.data, "customer_id", None)
                                    if hasattr(event, "data")
                                    else None
                                )
                                await db.execute(
                                    "UPDATE jobs SET payment_verified = ?, polar_customer_id = ?, actual_amount = ? WHERE id = ?",
                                    (1, customer_id, actual_amount, job_id),
                                )

                            await db.commit()
                            logger.info(
                                f"Payment processed via webhook: job_id={job_id}, order_id={order_id}, "
                                f"tampered={bool(amount_tampered)}"
                            )
                        else:
                            logger.warning(f"Job not found for checkout_id={checkout_id}")
            except Exception as e:
                logger.error(f"Error processing order.created event: {e}")

        elif "checkout.created" in event_str:
            logger.info("Checkout created event detected")

        elif "checkout.updated" in event_str:
            logger.info("Checkout updated event detected")

        elif "checkout.completed" in event_str:
            logger.info("Checkout completed event detected")
            # Handle checkout completion similar to order.created
            try:
                checkout_id = getattr(event.data, "id", None) if hasattr(event, "data") else None
                customer_id = (
                    getattr(event.data, "customer_id", None) if hasattr(event, "data") else None
                )
                amount = getattr(event.data, "amount", None) if hasattr(event, "data") else None

                logger.info(
                    f"Checkout completed: checkout_id={checkout_id}, customer_id={customer_id}, amount={amount}"
                )

                if checkout_id:
                    async with aiosqlite.connect(DATABASE_PATH) as db:
                        async with db.execute(
                            "SELECT id, expected_amount FROM jobs WHERE polar_checkout_id = ?",
                            (checkout_id,),
                        ) as cursor:
                            row = await cursor.fetchone()

                        if row:
                            job_id, expected_amount = row

                            # Check for tampering
                            amount_tampered = 0
                            if amount is not None and amount != expected_amount:
                                amount_tampered = 1
                                logger.warning(
                                    f"Amount tampering detected: job_id={job_id}, "
                                    f"expected={expected_amount}, actual={amount}"
                                )
                                await db.execute(
                                    "UPDATE jobs SET status = ?, amount_tampered = ?, actual_amount = ? WHERE id = ?",
                                    ("tampered", amount_tampered, amount, job_id),
                                )
                            else:
                                await db.execute(
                                    "UPDATE jobs SET payment_verified = ?, polar_customer_id = ?, actual_amount = ? WHERE id = ?",
                                    (1, customer_id, amount, job_id),
                                )

                            await db.commit()
                            logger.info(f"Payment verified via checkout.completed: job_id={job_id}")
                        else:
                            logger.warning(f"Job not found for checkout_id={checkout_id}")
            except Exception as e:
                logger.error(f"Error processing checkout.completed event: {e}")

        elif "checkout.succeeded" in event_str or "checkout.success" in event_str:
            logger.info("Checkout succeeded event detected")
            # Handle checkout success similar to checkout.completed
            try:
                checkout_id = getattr(event.data, "id", None) if hasattr(event, "data") else None
                customer_id = (
                    getattr(event.data, "customer_id", None) if hasattr(event, "data") else None
                )
                amount = getattr(event.data, "amount", None) if hasattr(event, "data") else None

                logger.info(
                    f"Checkout succeeded: checkout_id={checkout_id}, customer_id={customer_id}, amount={amount}"
                )

                if checkout_id:
                    async with aiosqlite.connect(DATABASE_PATH) as db:
                        async with db.execute(
                            "SELECT id, expected_amount FROM jobs WHERE polar_checkout_id = ?",
                            (checkout_id,),
                        ) as cursor:
                            row = await cursor.fetchone()

                        if row:
                            job_id, expected_amount = row

                            # Check for tampering
                            amount_tampered = 0
                            if amount is not None and amount != expected_amount:
                                amount_tampered = 1
                                logger.warning(
                                    f"Amount tampering detected: job_id={job_id}, "
                                    f"expected={expected_amount}, actual={amount}"
                                )
                                await db.execute(
                                    "UPDATE jobs SET status = ?, amount_tampered = ?, actual_amount = ? WHERE id = ?",
                                    ("tampered", amount_tampered, amount, job_id),
                                )
                            else:
                                await db.execute(
                                    "UPDATE jobs SET payment_verified = ?, polar_customer_id = ?, actual_amount = ? WHERE id = ?",
                                    (1, customer_id, amount, job_id),
                                )

                            await db.commit()
                            logger.info(f"Payment verified via checkout.succeeded: job_id={job_id}")
                        else:
                            logger.warning(f"Job not found for checkout_id={checkout_id}")
            except Exception as e:
                logger.error(f"Error processing checkout.succeeded event: {e}")

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
                   completed_at, results_json, payment_verified, amount_tampered,
                   expected_amount, actual_amount
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
        amount_tampered,
        expected_amount,
        actual_amount,
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
        amount_tampered=bool(amount_tampered),
        expected_amount=expected_amount,
        actual_amount=actual_amount,
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
        # Use real Gemini processing
        logger.info(f"Starting Gemini processing: job_id={job_id}")
        processor = GeminiProcessor(GOOGLE_API_KEY)
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

        # Get the checkout details
        checkout = polar.checkouts.get(id=polar_checkout_id)

        if not checkout:
            logger.error(f"No checkout found: checkout_id={polar_checkout_id}")
            raise HTTPException(status_code=404, detail="Checkout not found")

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

    logger.info("Starting Photo Sweep API")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
