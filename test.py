from google import genai
from google.genai import types
import json
import time
import os
import sys
import argparse
import tempfile

# --- Configuration ---
# The model to use for the batch processing job.
MODEL_ID = "gemini-2.5-flash"
DISPLAY_NAME = "test-batch-job"
# Time in seconds to wait between checking the job status.
POLLING_INTERVAL = 30

# --- Structured Output Schema ---
# Define the schema for the desired JSON output
# This schema dictates the structure of the JSON the model should return.
RESPONSE_SCHEMA = {
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

def process_batch_job(input_file_path: str):
    """
    Uploads a JSONL file, creates a batch job, waits for it to complete,
    and prints the results.
    """
    # 1. --- SETUP ---
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("Error: GOOGLE_API_KEY environment variable not set.")
        sys.exit(1)

    # Note: We configure the client here, but upload_file is a top-level function.
    # genai.configure(api_key=api_key, client_options={'api_version': 'v1alpha'})
    print(f"Initializing Gemini client for model: {MODEL_ID}")
    client = genai.Client(api_key=api_key,http_options={'api_version': 'v1alpha'})

    temp_file_path = None

    try:
        # 2. --- PREPARE INPUT FILE WITH STRUCTURED OUTPUT SCHEMA ---
        print(f"\nPatching input file '{input_file_path}' for structured output...")
        i = 0
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix=".jsonl") as temp_file:
            temp_file_path = temp_file.name
            with open(input_file_path, 'r', encoding='utf-8') as f_in:
                for line in f_in:
                    if not line.strip():
                        continue
                    record = json.loads(line)
                    if 'request' not in record:
                        record['request'] = {}
                    if 'generation_config' not in record['request']:
                        record['request']['generation_config'] = {}
                    
                    record['request']['generation_config']['responseMimeType'] = "application/json"
                    record['request']['generation_config']['responseSchema'] = RESPONSE_SCHEMA
                    temp_file.write(json.dumps(record) + '\n')
                    i += 1
                    if i > 2:
                        break
            print(f"Patched data written to temporary file: {temp_file_path}")

        # 3. --- UPLOAD FILE ---
        print(f"\nUploading input file: {temp_file_path}...")
        try:
            # *** THIS IS THE CORRECTED LINE ***
            # Use the top-level genai.upload_file function which accepts mime_type
            uploaded_file = client.files.upload(
                file=temp_file_path,
                config=types.UploadFileConfig(display_name=DISPLAY_NAME,mime_type='application/jsonl')
            )
            print(f"File uploaded successfully: {uploaded_file.name}")
        except Exception as e:
            print(f"Error uploading file: {e}")
            sys.exit(1)

        # 4. --- CREATE BATCH JOB ---
        print(f"\nCreating batch job with model '{MODEL_ID}'...")
        try:
            job = client.batches.create(
                model=MODEL_ID,
                src=uploaded_file.name,
                config=types.CreateBatchJobConfig(display_name=DISPLAY_NAME)
            )
            print(f"Batch job created: {job.name}")
        except Exception as e:
            print(f"Error creating batch job: {e}")
            sys.exit(1)


        # Poll the job status until it's completed.
        while True:
            batch_job = client.batches.get(name=job.name)
            if batch_job.state.name in ('JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED'):
                break
            print(f"Job not finished. Current state: {batch_job.state.name}. Waiting 30 seconds...")
            time.sleep(30)

        print(f"Job finished with state: {batch_job.state.name}")
        if batch_job.state.name == 'JOB_STATE_FAILED':
            print(f"Error: {batch_job.error}")


        if batch_job.state.name == 'JOB_STATE_SUCCEEDED':
            # The output is in another file.
            result_file_name = batch_job.dest.file_name
            print(f"Results are in file: {result_file_name}")

            print("\nDownloading and parsing result file content...")
            file_content_bytes = client.files.download(file=result_file_name)
            file_content = file_content_bytes.decode('utf-8')

            # The result file is also a JSONL file. Parse and print each line.
            for line in file_content.splitlines():
                if line:
                    result = json.loads(line)["response"]["candidates"][0]["content"]
                    if "parts" not in result:
                        continue
                    print(json.loads(result["parts"][0]["text"]))
                    print("-" * 20)
        else:
            print(f"Job did not succeed. Final state: {batch_job.state.name}")

    finally:
        # Clean up the temporary file regardless of success or failure
        if temp_file_path and os.path.exists(temp_file_path):
            os.remove(temp_file_path)
            print(f"\nCleaned up temporary file: {temp_file_path}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Process a JSONL file in batch mode with Gemini.")
    parser.add_argument("input_file", help="Path to the input JSONL file.")
    args = parser.parse_args()
    
    process_batch_job(args.input_file)