# Google Photos Manager

A simple FastAPI application for managing Google Photos with AI-powered duplicate detection and organization.

## Features

1. **Photo Ingestion**: Upload photos with metadata to SQLite database
2. **Embedding Calculation**: Generate image embeddings using Facebook's DINOv2 model
3. **AI Analysis**: Use OpenAI GPT-4o to identify photos for deletion
4. **Gemini Batch Processing**: Use Google's Gemini API in batch mode for cost-effective photo analysis at scale
5. **Visual Review**: Web interface to review AI suggestions and manage photos
6. **Grouping**: View photos grouped by date or status
7. **Filtering**: Filter photos by status and AI suggestions

## Setup

### Prerequisites

- Python 3.8+
- OpenAI API key (optional, for traditional AI analysis)
- Google API key (optional, for Gemini batch processing)

### Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Set up API keys (optional):
```bash
export OPENAI_API_KEY="your-openai-api-key-here"
export GOOGLE_API_KEY="your-google-api-key-here"
```

3. Run the application:
```bash
python main.py
```

The application will be available at `http://localhost:8000`

## API Endpoints

### POST /ingest
Ingest a photo into the database.

**Request Body:**
```json
{
    "id": "unique-photo-id",
    "mediaType": "image/jpeg",
    "dateTaken": "2024-01-01T12:00:00Z",
    "base64": "base64-encoded-image-data",
    "googlePhotosUrl": "https://photos.google.com/photo/123"
}
```

### GET /photos
List all photos in the database.

**Response:**
```json
{
    "photos": [
        {
            "id": "photo-1",
            "creation_time": "2024-01-01T12:00:00Z",
            "google_photos_url": "https://photos.google.com/photo/123",
            "status": "ingested",
            "group_id": null,
            "ai_suggestion_reason": null,
            "is_marked_for_deletion": false
        }
    ]
}
```

### POST /calculate-embeddings
Calculate embeddings for photos that don't have them.

**Response:**
```json
{
    "message": "Processed 5 photos",
    "processed_count": 5
}
```

### POST /ai-analysis
Analyze photos using OpenAI GPT-4o to suggest deletions.

**Response:**
```json
{
    "message": "AI analysis completed. 3 photos marked for review",
    "analyzed_count": 3
}
```

### GET /photo/{photo_id}
Get photo image by ID.

### POST /review/{photo_id}
Review AI suggestion for a photo.

**Form Data:**
- `action`: "approve" or "reject"

### POST /create-batch-job
Create a Gemini batch job for photo analysis.

**Response:**
```json
{
    "message": "Batch job created successfully with 5 requests",
    "batch_id": "uuid-here",
    "job_name": "batches/job-name",
    "total_requests": 5
}
```

### POST /process-batch-results
Process completed batch job results and update photo deletion suggestions.

**Response:**
```json
{
    "message": "Processed 2 batch jobs",
    "processed_jobs": 2
}
```

### GET /batch-jobs
List all batch jobs with their status.

**Response:**
```json
{
    "jobs": [
        {
            "id": "uuid",
            "job_name": "batches/job-name",
            "display_name": "photo-analysis-uuid",
            "status": "completed",
            "created_at": "2024-01-01T12:00:00",
            "completed_at": "2024-01-01T12:30:00",
            "total_requests": 5,
            "processed_requests": 5,
            "error_message": null
        }
    ]
}
```

## Database Schema

### Photos Table
```sql
CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    creation_time TEXT,
    google_photos_url TEXT NOT NULL,
    image_blob BLOB NOT NULL,
    embedding BLOB,
    status TEXT NOT NULL DEFAULT 'ingested',
    group_id TEXT,
    ai_suggestion_reason TEXT,
    is_marked_for_deletion BOOLEAN DEFAULT FALSE
);
```

### Photo Vectors Table (for vector search)
```sql
CREATE VIRTUAL TABLE photo_vectors USING vec0(
    embedding FLOAT[768]
);
```

## Usage Workflow

### Traditional Workflow (OpenAI)
1. **Ingest Photos**: Use the `/ingest` endpoint to add photos to the database
2. **Calculate Embeddings**: Click "Calculate Embeddings" in the UI to process photos
3. **Create Groups**: Click "Create Groups" to group similar photos
4. **Run AI Analysis**: Click "Run AI Analysis (OpenAI)" to get immediate deletion suggestions
5. **Review Suggestions**: Use the web interface to approve or reject AI suggestions

### Batch Processing Workflow (Gemini)
1. **Ingest Photos**: Use the `/ingest` endpoint to add photos to the database
2. **Calculate Embeddings**: Click "Calculate Embeddings" in the UI to process photos
3. **Create Groups**: Click "Create Groups" to group similar photos
4. **Create Batch Job**: Click "Create Gemini Batch" to upload groups for analysis
5. **Wait for Processing**: Batch jobs can take up to 24 hours (usually much faster)
6. **Process Results**: Click "Process Batch Results" to retrieve and apply suggestions
7. **Review Suggestions**: Use the web interface to approve or reject AI suggestions

### Benefits of Batch Processing
- **Cost Effective**: 50% discount compared to standard API calls
- **High Throughput**: Process thousands of photos efficiently
- **Better Analysis**: More detailed analysis with comprehensive photo curation expertise
- **Asynchronous**: Submit job and check back later

## Web Interface

The web interface provides:

- **Dashboard**: Overview with statistics and photo grid
- **Filtering**: Filter by status, AI suggestions, and grouping options
- **Photo Cards**: Visual representation of photos with metadata
- **Review Actions**: Approve/reject AI suggestions with one click
- **Real-time Updates**: Automatic refresh after actions

## Technical Details

- **Embedding Model**: Facebook DINOv2 (768-dimensional embeddings)
- **Database**: SQLite with sqlite-vec extension for vector search
- **AI Model**: OpenAI GPT-4o (requires API key)
- **Image Processing**: PIL for image handling
- **Device Support**: CUDA, MPS, or CPU for embeddings

## Notes

- The AI analysis currently includes a simulation mode when OpenAI API key is not provided
- All photos are stored as BLOBs in the SQLite database for simplicity
- The application is designed to be simple and easy to review
- Vector search capabilities are available but not fully implemented in the current UI

## Development

To extend the application:

1. Add new endpoints in `main.py`
2. Update the HTML template in `templates/dashboard.html`
3. Modify the database schema in the `init_database()` function
4. Add new filtering/grouping options in the web interface

The codebase is intentionally kept simple for easy review and modification. 