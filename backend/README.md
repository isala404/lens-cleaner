# Photo Sweep Backend

Backend API for the Photo Sweep auto-select feature, powered by Google Gemini AI.

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Add your Google API key to `.env`

## Running

```bash
python main.py
```

Or with uvicorn:
```bash
uvicorn main:app --reload
```

The API will be available at `http://localhost:8000`

## API Endpoints

- `POST /v1/api/checkout` - Create checkout session
- `GET /v1/api/checkout/:checkout_id` - Mock checkout page
- `POST /v1/api/job/:job_id/upload` - Upload photos for processing
- `POST /v1/api/job/:job_id` - Start AI processing
- `GET /v1/api/job/:job_id` - Get job status (202 = processing, 200 = complete)

## Development

Format code:
```bash
black main.py
```

Lint code:
```bash
ruff check main.py
```
