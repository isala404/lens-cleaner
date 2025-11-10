"""
Gemini AI Integration for Photo Analysis
Handles batch processing of photos to identify duplicates and low-quality images
"""

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

# Gemini Configuration
BATCH_MODEL_ID = "gemini-2.0-flash"
POLLING_INTERVAL = 30  # seconds

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

SYSTEM_PROMPT = """You are an expert photo curator and digital asset manager with years of experience in identifying valuable photos versus redundant or low-quality images. Your task is to analyze groups of photos and identify which photos should be marked for deletion.

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

Be conservative - it's better to keep a questionable photo than to lose an irreplaceable memory."""


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

            # Prepare photo data
            content_parts = [{"text": SYSTEM_PROMPT}]

            for photo in group_photos:
                # Read photo file
                photo_path = upload_dir / photo["filename"]
                if not photo_path.exists():
                    continue

                with open(photo_path, "rb") as f:
                    photo_bytes = f.read()

                # Encode to base64
                photo_b64 = base64.b64encode(photo_bytes).decode("utf-8")

                # Add to content
                content_parts.append({"text": f"Photo id: {photo['id']}, group_id: {group_id}"})
                content_parts.append(
                    {"inline_data": {"mime_type": "image/jpeg", "data": photo_b64}}
                )

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
                        "temperature": 0.1,
                        "max_output_tokens": 4096,
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
        # Note: Do not specify mime_type for JSONL batch requests
        # The API will infer it from the file content
        uploaded_file = self.client.files.upload(
            file=str(jsonl_path),
            config=types.UploadFileConfig(display_name=f"lens-cleaner-{job_id}"),
        )
        return uploaded_file

    async def _create_batch_job(self, uploaded_file: Any, job_id: str) -> Any:
        """Create batch processing job"""
        batch_job = self.client.batches.create(
            model=BATCH_MODEL_ID,
            src=uploaded_file.name,
            config=types.CreateBatchJobConfig(display_name=f"lens-cleaner-{job_id}"),
        )
        return batch_job

    async def _poll_for_completion(self, batch_job_name: str) -> Any:
        """Poll for batch job completion"""
        while True:
            batch_job = self.client.batches.get(name=batch_job_name)

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
                print(f"Error parsing result line: {e}")
                continue

        return {"deletions": deletions}
