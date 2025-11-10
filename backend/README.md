# Lens Cleaner Backend

Backend service for Lens Cleaner's AI-powered auto-select feature. This service handles payment processing, photo uploads, and Gemini AI batch processing for intelligent photo deletion suggestions.

## Features

- 💰 Cost calculation and payment tracking
- 📤 Resumable photo uploads with multipart support
- 🤖 Google Gemini AI batch processing
- 📊 Real-time job status tracking
- 🔄 Background polling for async processing
- 💾 SQLite database (pure Go, no CGO)
- 🔒 CORS-enabled API

## Tech Stack

- **Language**: Go 1.23+
- **Web Framework**: Gin
- **Database**: SQLite (modernc.org/sqlite - pure Go)
- **AI**: Google Gemini API
- **Architecture**: RESTful API with background workers

## Prerequisites

- Go 1.23 or higher
- Google Cloud API key with Gemini API access

## Installation

1. Clone the repository:
```bash
cd backend
```

2. Install dependencies:
```bash
go mod download
```

3. Copy environment file:
```bash
cp .env.example .env
```

4. Configure your `.env` file with:
   - `GOOGLE_API_KEY`: Your Google Cloud API key
   - Other configuration as needed (see `.env.example`)

## Running the Server

### Development
```bash
go run cmd/server/main.go
```

### Production
```bash
# Build
go build -o server cmd/server/main.go

# Run
./server
```

### With Make
```bash
# Run in development
make run

# Build for production
make build

# Run tests
make test

# Format code
make fmt

# Run linter
make lint
```

## API Endpoints

### Health Check
```
GET /api/v1/health
```

### Cost Calculation
```
POST /api/v1/cost/calculate
Body: { "photo_count": 100 }
Response: { "photo_count": 100, "total_cost": 1.0, "currency": "USD", "price_per_photo": 0.01 }
```

### Create Payment
```
POST /api/v1/payments
Body: {
  "user_id": "user@example.com",
  "photo_count": 100,
  "amount_paid": 1.0,
  "payment_id": "polar_payment_123",
  "payment_provider": "polar"
}
```

### Create Job
```
POST /api/v1/jobs
Body: {
  "payment_id": "uuid",
  "user_id": "user@example.com",
  "photo_count": 100
}
Response: { "job_id": "uuid", "status": "created" }
```

### Upload Photo
```
POST /api/v1/jobs/:jobId/upload
Content-Type: multipart/form-data
Fields:
  - photo_id: "photo_123"
  - photo: (file)
```

### Submit Grouping
```
POST /api/v1/grouping/submit
Body: {
  "job_id": "uuid",
  "grouping_data": {
    "groups": {
      "group_1": ["photo_1", "photo_2"],
      "group_2": ["photo_3", "photo_4"]
    }
  }
}
```

### Get Job Status
```
GET /api/v1/jobs/:jobId/status
Response: {
  "id": "uuid",
  "status": "processing",
  "total_photos": 100,
  "uploaded_photos": 100,
  "processed_photos": 50,
  "progress": 75.0,
  "estimated_time": 100
}
```

### Get Results
```
GET /api/v1/jobs/:jobId/results
Response: {
  "job_id": "uuid",
  "results": [
    {
      "id": "uuid",
      "photo_id": "photo_1",
      "group_id": "group_1",
      "should_delete": true,
      "reason": "Blurry image, better version exists",
      "confidence": "high"
    }
  ]
}
```

### Get Refund Template
```
GET /api/v1/refund/template?job_id=uuid&email=user@example.com
Response: {
  "subject": "Refund Request for Job xxx",
  "body": "...",
  "to": "refunds@tallisa.dev",
  "unused_photos": 10,
  "refund_amount": 0.10
}
```

## Job Status Flow

```
created → uploading → uploaded → processing → completed
                                          ↓
                                       failed
```

## Background Worker

The background worker polls for active jobs every 30 seconds (configurable) and:
1. Creates Gemini batch jobs for uploaded jobs
2. Checks status of processing jobs
3. Processes completed results
4. Updates job status accordingly

## Pricing

- Default: $0.01 per photo ($10 per 1000 photos)
- Configurable via `PRICE_PER_PHOTO` environment variable
- Tolerance: +10 photos over paid amount (configurable via `TOLERANCE`)

## Error Handling

- Failed uploads can be retried (idempotent)
- Resume support for interrupted uploads
- Automatic retry for failed jobs
- Detailed error messages in job status

## Database Schema

### Tables
- `payments`: Payment records
- `jobs`: Processing jobs
- `uploaded_photos`: Uploaded photo metadata
- `processing_results`: AI analysis results

### Indexes
- User ID, Payment ID, Job ID
- Status fields for efficient queries
- Photo IDs for fast lookups

## Development

### Code Structure
```
backend/
├── cmd/
│   └── server/          # Main application entry point
├── internal/
│   ├── api/            # HTTP handlers and background worker
│   ├── db/             # Database layer
│   ├── gemini/         # Gemini AI integration
│   └── models/         # Data models
└── pkg/                # Public packages (if any)
```

### Adding New Endpoints

1. Add handler to `internal/api/handlers.go`
2. Add route in `cmd/server/main.go`
3. Update models in `internal/models/models.go` if needed
4. Add database methods in `internal/db/db.go` if needed

## Testing

```bash
# Run all tests
go test ./...

# Run tests with coverage
go test -cover ./...

# Run tests with race detection
go test -race ./...
```

## Deployment

### Docker
```dockerfile
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN go build -o server cmd/server/main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/server .
EXPOSE 8080
CMD ["./server"]
```

### Environment Variables (Production)
```bash
PORT=8080
HOST=0.0.0.0
GOOGLE_API_KEY=your_key
DATABASE_PATH=/data/lens_cleaner.db
UPLOAD_DIR=/data/uploads
```

## Notes on Gemini Batch API

The Google Gemini Go SDK doesn't fully support the Batch API yet. You may need to:
1. Use the REST API directly for batch job creation and status checking
2. Implement custom HTTP clients for these operations
3. Wait for SDK updates

Placeholders are marked with `TODO` comments in the code.

## License

MIT

## Support

For issues or questions:
- GitHub Issues: [repository link]
- Email: refunds@tallisa.dev (for refund requests)
