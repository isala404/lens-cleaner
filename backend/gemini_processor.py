"""
Gemini AI Integration for Photo Analysis
Handles batch processing of photos to identify duplicates and low-quality images
"""

import asyncio
import base64
import json
import logging
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Gemini Configuration
BATCH_MODEL_ID = "gemini-flash-latest"
POLLING_INTERVAL = 30  # seconds
MAX_PHOTOS_PER_GROUP = 100  # Maximum photos per group to avoid API limits

# Structured Output Schema
BATCH_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "analysis": {"type": "STRING"},
        "deletions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "photo_id": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]},
                },
                "required": ["photo_id", "reason", "confidence"],
            },
        },
    },
    "required": ["analysis", "deletions"],
}

SYSTEM_PROMPT = """You are an expert photo curator specializing in intelligent photo decluttering. Your task is to identify which photos should be marked for deletion from groups of similar images, while preserving every photo that has unique value.

PRIMARY OBJECTIVE:
Identify redundant, low-quality, or unnecessary photos for deletion while ensuring NO valuable memories are lost. When analyzing groups of 10-50+ similar photos, provide specific, unique reasons for each deletion recommendation.

DELETION PRIORITIES (Mark these for deletion):

1. TECHNICAL FAILURES:
   - Severely blurry, out-of-focus, or motion-blurred beyond recognition
   - Extreme exposure problems (completely black, blown out white)
   - Accidental shots (finger over lens, pocket shots, ground/ceiling)
   - Corrupted or partially loaded images

2. REDUNDANT DUPLICATES:
   - When multiple nearly-identical shots exist, delete the inferior versions:
     * Poorer focus/sharpness
     * Worse exposure or color
     * Less favorable expressions or timing
     * Awkward framing or composition
   - Keep ONLY the best 1-2 versions of each unique moment/angle

3. HUMAN SUBJECT ISSUES:
   - Eyes closed (unless it's the only photo of that moment)
   - Mid-blink, mid-speech unflattering expressions
   - Someone looking away when others are engaged
   - Obvious test shots before the "real" photo

4. LOW-VALUE CONTENT:
   - Screenshots of temporary information
   - Blurry photos of menus, signs, or documents (unless only copy)
   - Redundant establishment shots (multiple photos of same building/landmark)
   - Failed attempts at artistic shots with no redeeming qualities

PRESERVATION RULES (NEVER delete these):

1. UNIQUE PERSPECTIVES:
   - Different angles of the same subject (even if similar)
   - Different focal points or depths of field
   - Variations in lighting or time of day
   - Different groupings of people
   - Different focus of interest (person or object)

2. STORY PROGRESSION:
   - Photos showing sequence or progression of events
   - Before/during/after shots
   - Different activities or contexts
   - Candid moments between posed shots

3. EMOTIONAL OR DOCUMENTARY VALUE:
   - Genuine emotions or reactions
   - Spontaneous moments
   - Historical significance (even if technically imperfect)
   - Last photo of a person, place, or event

DECISION FRAMEWORK:

For each photo group:
1. First identify the PRIMARY PURPOSE of why these photos were taken
2. Determine which photos fulfill that purpose BEST
3. Identify which photos are REDUNDANT to that purpose
4. For similar-looking photos, check if they serve DIFFERENT purposes (different angle = different artistic intent)
5. Mark for deletion ONLY photos that:
   - Fail to serve any unique purpose
   - Are technically inferior versions of preserved photos
   - Add no additional value to the collection

CONFIDENCE LEVELS:
- HIGH: Clear duplicate/failure with better alternatives present
- MEDIUM: Likely redundant but might have subtle unique value
- LOW: Questionable deletion - photo has issues but might be only version

ANALYSIS APPROACH:
- For large batches (20-50+ photos), identify patterns and group by:
  * Burst sequences (keep best 1-2)
  * Different scenes/subjects
  * Time gaps between shots
  * Intentional variations vs. accidents
- Provide SPECIFIC, UNIQUE reasons for each deletion (avoid generic "similar to photo X" - explain WHY it's inferior)
- Consider the photographer's apparent intent - preserve photos that represent deliberate creative choices

Remember: When uncertain, PRESERVE the photo. Storage is cheap, memories are priceless."""


class GeminiProcessor:
    """Handles Gemini AI batch processing for photo analysis"""

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("GOOGLE_API_KEY is required")
        self.client = genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})

    async def process_photos(
        self, job_id: str, upload_dir: Path, photo_metadata: list[dict]
    ) -> dict[str, Any]:
        """
        Process photos using Gemini batch API

        Args:
            job_id: Unique job identifier
            upload_dir: Directory containing uploaded photos
            photo_metadata: List of photo metadata (id, filename, group_id, etc.)

        Returns:
            Dictionary containing analysis results
        """
        # Create JSONL file
        jsonl_path = await self._create_batch_jsonl(upload_dir, photo_metadata)

        # Upload to Gemini Files API
        uploaded_file = await self._upload_jsonl(jsonl_path, job_id)

        # Create and start batch job
        batch_job = await self._create_batch_job(uploaded_file, job_id)

        # Poll for completion
        results = await self._poll_for_completion(batch_job.name)

        # Parse and return results
        return await self._parse_results(results)

    async def _create_batch_jsonl(self, upload_dir: Path, photo_metadata: list[dict]) -> Path:
        """Create JSONL file with photo analysis requests"""
        jsonl_path = upload_dir / "batch_requests.jsonl"

        # Group photos by group_id
        photo_groups: dict[str, list[dict]] = {}
        for photo in photo_metadata:
            group_id = photo.get("group_id", "ungrouped")
            if group_id not in photo_groups:
                photo_groups[group_id] = []
            photo_groups[group_id].append(photo)

        requests_data = []

        for group_id, group_photos in photo_groups.items():
            if len(group_photos) <= 1:
                continue  # Skip single photo groups

            # Skip groups that are too large to avoid API limits
            if len(group_photos) > MAX_PHOTOS_PER_GROUP:
                logger.warning(
                    f"Skipping group {group_id} with {len(group_photos)} photos "
                    f"(exceeds limit of {MAX_PHOTOS_PER_GROUP}). "
                    "This group is too large for batch processing."
                )
                continue

            # Prepare photo data
            content_parts: list[dict[str, Any]] = [{"text": SYSTEM_PROMPT}]

            for photo in group_photos:
                # Read photo file
                photo_path = upload_dir / photo["filename"]
                if not photo_path.exists():
                    continue

                with open(photo_path, "rb") as f:
                    photo_bytes = f.read()

                # Encode to base64
                photo_b64 = base64.b64encode(photo_bytes).decode("utf-8")

                # Default to image/jpeg for all photos to avoid mime type errors
                media_type = "image/jpeg"

                # Add to content
                content_parts.append({"text": f"Photo id: {photo['id']}, group_id: {group_id}"})
                content_parts.append({"inline_data": {"mime_type": media_type, "data": photo_b64}})

            content_parts.append(
                {
                    "text": f"Please analyze this group of {len(group_photos)} photos and identify which ones should be marked for deletion."
                }
            )

            # Create request
            request_data = {
                "request": {
                    "contents": [{"parts": content_parts}],
                    "generation_config": {
                        "thinkingConfig": {"thinkingBudget": 1024},
                        "temperature": 0.5,
                        "max_output_tokens": 6 * 1024,
                        "responseMimeType": "application/json",
                        "responseSchema": BATCH_RESPONSE_SCHEMA,
                    },
                }
            }

            requests_data.append(request_data)

        # Write JSONL
        with open(jsonl_path, "w") as f:
            for req in requests_data:
                f.write(json.dumps(req) + "\n")

        return jsonl_path

    async def _upload_jsonl(self, jsonl_path: Path, job_id: str) -> Any:
        """Upload JSONL file to Gemini Files API"""
        try:
            uploaded_file = self.client.files.upload(
                file=str(jsonl_path),
                config=types.UploadFileConfig(
                    display_name=f"top-pics-{job_id}", mime_type="text/plain"
                ),
            )
            return uploaded_file
        except Exception as e:
            logger.error(f"Error uploading JSONL file: {e}")
            raise

    async def _create_batch_job(self, uploaded_file: Any, job_id: str) -> Any:
        """Create batch processing job"""
        batch_job = self.client.batches.create(
            model=BATCH_MODEL_ID,
            src=uploaded_file.name,
            config=types.CreateBatchJobConfig(display_name=f"top-pics-{job_id}"),
        )
        return batch_job

    async def _poll_for_completion(self, batch_job_name: str) -> Any:
        """Poll for batch job completion"""
        while True:
            batch_job = self.client.batches.get(name=batch_job_name)

            if not batch_job or not batch_job.state:
                raise Exception(f"Batch job not found or invalid: {batch_job_name}")

            if batch_job.state.name == "JOB_STATE_SUCCEEDED":
                return batch_job
            elif batch_job.state.name in ["JOB_STATE_FAILED", "JOB_STATE_CANCELLED"]:
                raise Exception(f"Batch job failed: {batch_job.state.name}")

            # Wait before next poll
            await asyncio.sleep(POLLING_INTERVAL)

    async def _parse_results(self, batch_job: Any) -> dict[str, Any]:
        """Parse batch job results"""
        result_file_name = batch_job.dest.file_name
        file_content_bytes = self.client.files.download(file=result_file_name)
        file_content = file_content_bytes.decode("utf-8")

        deletions = []

        for line in file_content.splitlines():
            if not line:
                continue

            try:
                parsed_response = json.loads(line)

                if "response" in parsed_response and "candidates" in parsed_response["response"]:
                    candidate = parsed_response["response"]["candidates"][0]

                    # Skip if max tokens reached
                    if candidate.get("finishReason") == "MAX_TOKENS":
                        continue

                    response_content = candidate["content"]

                    if "parts" in response_content and len(response_content["parts"]) > 0:
                        response_text = response_content["parts"][0]["text"]
                        ai_response = json.loads(response_text)
                        deletions.extend(ai_response.get("deletions", []))

            except (json.JSONDecodeError, KeyError) as e:
                logger.error(f"Error parsing result line: {e}")
                continue

        return {"deletions": deletions}
