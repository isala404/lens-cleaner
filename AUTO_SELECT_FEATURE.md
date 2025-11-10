# Auto-Select Feature Documentation

This document describes the AI-powered auto-select feature for Lens Cleaner, including architecture, setup, and usage.

## Overview

The auto-select feature allows users to pay for AI-powered analysis of their photo groups. The AI (Google Gemini) analyzes photos and intelligently suggests which ones to delete based on quality, duplicates, and artistic value.

### Flow

1. **User extracts images** → Index locally → Group locally
2. **User initiates auto-select** → Calculate cost → Show payment
3. **User pays via Polar.sh** → Payment recorded
4. **Upload photos** → Parallel upload with retry (20 concurrent, configurable)
5. **Submit grouping data** → Backend validates against paid amount
6. **Backend processing**:
   - Build JSONL for Gemini Batch API
   - Submit to Gemini for processing
   - Poll every 30 seconds for completion
7. **Frontend polling** → Check job status every 30 seconds
8. **Results retrieved** → Saved to IndexedDB → Auto-select on UI

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  UI (Svelte)                                         │  │
│  │  - AutoSelect.svelte: Payment & upload flow         │  │
│  │  - RegroupWarning.svelte: Warning modal             │  │
│  │  - RefundTemplate.svelte: Refund email              │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Core Libraries                                      │  │
│  │  - api-client.ts: Backend API communication         │  │
│  │  - upload-manager.ts: Parallel upload + retry       │  │
│  │  - ai-db.ts: IndexedDB for jobs & results           │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  IndexedDB                                           │  │
│  │  - Photos, Groups, Embeddings (existing)            │  │
│  │  - AI Jobs, AI Results (new)                        │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP/REST API
┌─────────────────────────────────────────────────────────────┐
│                     Backend (Go)                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  API Layer (Gin)                                     │  │
│  │  - Cost calculation                                  │  │
│  │  - Payment creation                                  │  │
│  │  - Job management                                    │  │
│  │  - Photo upload (multipart)                          │  │
│  │  - Grouping submission & validation                  │  │
│  │  - Job status polling                                │  │
│  │  - Results retrieval                                 │  │
│  │  - Refund template generation                        │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Background Worker                                   │  │
│  │  - Polls for uploaded jobs every 30s                 │  │
│  │  - Creates Gemini batch jobs                         │  │
│  │  - Polls Gemini for completion                       │  │
│  │  - Processes and stores results                      │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  SQLite Database (pure Go, no CGO)                   │  │
│  │  - payments, jobs, uploaded_photos, processing       │  │
│  │    _results                                          │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  File Storage                                        │  │
│  │  - uploads/{jobId}/{photoId}.jpg                     │  │
│  │  - batch_requests_{jobId}.jsonl                      │  │
│  │  - batch_results_{jobId}.jsonl                       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ Gemini API
┌─────────────────────────────────────────────────────────────┐
│              Google Gemini Batch API                         │
│  - Receives JSONL with grouped photos                        │
│  - Analyzes each group with AI                               │
│  - Returns deletion suggestions with reasons                 │
└─────────────────────────────────────────────────────────────┘
```

## Pricing

- **$0.01 per photo** ($10 per 1000 photos)
- Configurable via `PRICE_PER_PHOTO` environment variable
- Tolerance: +10 photos over paid amount (configurable)

## Setup

### Backend Setup

1. **Prerequisites**:
   ```bash
   - Go 1.23+
   - Google Cloud API key with Gemini API access
   - Polar.sh account for payments
   ```

2. **Install Dependencies**:
   ```bash
   cd backend
   go mod download
   ```

3. **Configure Environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your keys:
   # - GOOGLE_API_KEY
   # - POLAR_API_KEY (for webhook verification)
   ```

4. **Run Backend**:
   ```bash
   # Development
   make run

   # Production
   make build
   ./lens-cleaner-backend
   ```

### Frontend Setup

1. **Configure API URL**:
   Create `chrome-extensions/.env`:
   ```env
   VITE_API_BASE_URL=http://localhost:8080/api/v1
   ```

2. **Build Extension**:
   ```bash
   cd chrome-extensions
   npm install
   npm run build
   ```

3. **Load Extension**:
   - Open Chrome → Extensions → Enable Developer Mode
   - Load unpacked → Select `chrome-extensions/dist`

## Integration

### Adding Auto-Select to Main UI

In `App.svelte`, import and add the components:

```svelte
<script lang="ts">
  import AutoSelect from './lib/AutoSelect.svelte';
  import RegroupWarning from './lib/RegroupWarning.svelte';
  import RefundTemplate from './lib/RefundTemplate.svelte';
  import aiDB from './lib/ai-db';

  let showAutoSelect = false;
  let showRegroupWarning = false;
  let showRefundTemplate = false;
  let hasActiveJob = false;
  let jobId = '';
  let userEmail = '';

  // Check for active job on mount
  onMount(async () => {
    await aiDB.init();
    const job = await aiDB.getLatestJob();
    if (job && (job.status === 'processing' || job.status === 'completed')) {
      hasActiveJob = true;
      jobId = job.id;
      userEmail = job.userId;
    }
  });

  function handleAutoSelectClick() {
    showAutoSelect = true;
  }

  function handleAutoSelectComplete(results) {
    showAutoSelect = false;
    // Apply AI suggestions to photo selection
    results.forEach((suggestion, photoId) => {
      if (suggestion.shouldDelete) {
        // Mark photo for deletion in UI
        togglePhotoSelection(photoId, true, suggestion.reason);
      }
    });
  }

  function handleRegroupClick() {
    if (hasActiveJob) {
      showRegroupWarning = true;
    } else {
      // Proceed with regrouping directly
      performRegroup();
    }
  }

  function performRegroup() {
    // Clear AI suggestions
    aiDB.clearAll();
    // Trigger regrouping
    groupPhotos();
    showRegroupWarning = false;
  }
</script>

<!-- In your UI -->
{#if currentStep === 'reviewing'}
  <button on:click={handleAutoSelectClick}>
    🤖 AI Auto-Select (Paid)
  </button>

  {#if hasActiveJob}
    <button on:click={() => showRefundTemplate = true}>
      💰 Request Refund
    </button>
  {/if}
{/if}

<!-- Modals -->
{#if showAutoSelect}
  <AutoSelect
    groups={groupsMap}
    onComplete={handleAutoSelectComplete}
    onCancel={() => showAutoSelect = false}
  />
{/if}

{#if showRegroupWarning}
  <RegroupWarning
    onConfirm={performRegroup}
    onCancel={() => showRegroupWarning = false}
  />
{/if}

{#if showRefundTemplate}
  <RefundTemplate
    {jobId}
    {userEmail}
    onClose={() => showRefundTemplate = false}
  />
{/if}
```

### Blocking Regrouping During Processing

```typescript
// In your grouping function
async function groupPhotos() {
  const job = await aiDB.getLatestJob();

  if (job && job.status === 'processing') {
    alert('Cannot regroup while AI processing is in progress. Please wait or cancel the job.');
    return;
  }

  if (job && job.status === 'completed') {
    showRegroupWarning = true;
    return;
  }

  // Proceed with normal grouping
  // ...
}
```

## Payment Integration

### Polar.sh Integration

The payment flow needs to be integrated with Polar.sh:

1. **Create a product** in Polar.sh dashboard
2. **Configure webhook** for payment confirmation
3. **Update frontend** payment button:

```svelte
async function initiatePayment() {
  const checkoutUrl = `https://polar.sh/checkout?product_id=YOUR_PRODUCT_ID&amount=${cost.total * 100}&metadata[user_email]=${userId}&metadata[photo_count]=${totalPhotos}`;
  window.open(checkoutUrl, '_blank');

  // Listen for payment confirmation (via polling or webhook)
  // Once confirmed, call handlePayment()
}
```

4. **Backend webhook handler** (add to `internal/api/handlers.go`):

```go
func (a *API) PolarWebhook(c *gin.Context) {
    // Verify webhook signature
    // Extract payment data
    // Call CreatePayment internally
    // Return success
}
```

## API Reference

See `backend/README.md` for complete API documentation.

### Key Endpoints

- `POST /api/v1/cost/calculate` - Calculate cost
- `POST /api/v1/payments` - Create payment record
- `POST /api/v1/jobs` - Create processing job
- `POST /api/v1/jobs/:jobId/upload` - Upload photo
- `POST /api/v1/grouping/submit` - Submit grouping data
- `GET /api/v1/jobs/:jobId/status` - Get job status
- `GET /api/v1/jobs/:jobId/results` - Get results
- `GET /api/v1/refund/template` - Get refund email template

## Database Schema

### Frontend (IndexedDB)

**LensCleanerAI Database**:
- `ai_jobs` - Job tracking
- `ai_results` - AI suggestions

### Backend (SQLite)

- `payments` - Payment records
- `jobs` - Processing jobs
- `uploaded_photos` - Uploaded photo metadata
- `processing_results` - AI analysis results

## Error Handling

### Upload Failures

- Automatic retry with exponential backoff
- Resume support via localStorage
- Failed uploads clearly indicated
- Manual retry button

### Processing Failures

- Error messages displayed to user
- Job status includes error details
- Can retry from beginning

### Payment Issues

- Validation before job creation
- Photo count vs paid amount check (+10 tolerance)
- Contact support message if exceeded

## Refund Policy

Users can request refunds for unused credits:

1. Click "Request Refund" button
2. System generates email template with:
   - Job ID
   - Unused photo count
   - Refund amount
3. User sends email to `refunds@tallisa.dev`
4. Manual processing within 5-7 business days

## Performance Considerations

- **Concurrent Uploads**: 20 parallel uploads (configurable)
- **Retry Logic**: 3 attempts with exponential backoff
- **Polling Interval**: 30 seconds (configurable)
- **Resume Support**: Can close browser and resume later
- **Background Processing**: Backend worker runs independently

## Testing

### Backend Tests

```bash
cd backend
make test
```

### Frontend Tests

```bash
cd chrome-extensions
npm test
```

### Manual Testing Flow

1. Group at least 10 photos
2. Click "AI Auto-Select"
3. Enter email and proceed
4. Simulate payment (or use test Polar.sh account)
5. Watch upload progress
6. Close and reopen to test resume
7. Wait for processing (or speed up polling for testing)
8. Check results application
9. Test regroup warning
10. Test refund template

## Deployment

### Backend Deployment

**Docker**:
```dockerfile
# See backend/README.md for Dockerfile
```

**Environment Variables**:
```env
PORT=8080
GOOGLE_API_KEY=your_key
DATABASE_PATH=/data/lens_cleaner.db
UPLOAD_DIR=/data/uploads
```

**Hosting Options**:
- Fly.io
- Railway
- Google Cloud Run
- AWS ECS
- Any VPS with Docker

### Frontend Deployment

The extension is already built for Chrome Web Store:

```bash
cd chrome-extensions
npm run build
# Upload dist/ to Chrome Web Store
```

## Monitoring

### Backend Logs

```bash
# Watch logs
tail -f /var/log/lens-cleaner/app.log

# Check job status
sqlite3 lens_cleaner.db "SELECT * FROM jobs WHERE status='processing'"
```

### Frontend Debugging

```javascript
// Check AI database
const job = await aiDB.getLatestJob();
console.log(job);

const results = await aiDB.getResultsByJob(jobId);
console.log(results);
```

## Known Issues & Limitations

1. **Gemini Batch API**: The Go SDK doesn't fully support batch API yet
   - Need to use REST API directly for batch job creation
   - Placeholders marked with TODO comments
   - See `backend/internal/gemini/gemini.go`

2. **Payment Integration**: Polar.sh integration is placeholder
   - Need to implement actual payment flow
   - Webhook handler needs to be added
   - See `src/lib/AutoSelect.svelte`

3. **Large Files**: Photos >10MB may timeout
   - Configure `MAX_UPLOAD_SIZE` in backend
   - Frontend should validate size before upload

4. **Browser Limitations**: IndexedDB quota varies
   - Typically 50MB+ available
   - May need to clear old jobs periodically

## Security Considerations

- API key stored in backend only (not exposed to frontend)
- CORS configured for specific origins in production
- Payment verification via Polar.sh webhooks
- File upload validation and sanitization
- SQLite injection prevention via parameterized queries
- Rate limiting recommended for production

## Support

- **Issues**: GitHub Issues
- **Refunds**: refunds@tallisa.dev
- **General**: support@tallisa.dev

## Future Enhancements

- [ ] Batch delete directly from extension
- [ ] Credit system (buy credits, use as needed)
- [ ] Different AI models (quality vs speed)
- [ ] Preview mode (see suggestions before paying)
- [ ] Group-by-group processing
- [ ] Export/import AI suggestions
- [ ] Analytics dashboard

## License

MIT - See LICENSE file
