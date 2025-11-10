package api

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/isala404/lens-cleaner/backend/internal/db"
	"github.com/isala404/lens-cleaner/backend/internal/gemini"
	"github.com/isala404/lens-cleaner/backend/internal/models"
)

// Worker handles background processing of jobs
type Worker struct {
	db           *db.Database
	geminiClient *gemini.Client
	pollInterval time.Duration
	stopChan     chan struct{}
}

// NewWorker creates a new background worker
func NewWorker(database *db.Database, geminiClient *gemini.Client, pollInterval time.Duration) *Worker {
	return &Worker{
		db:           database,
		geminiClient: geminiClient,
		pollInterval: pollInterval,
		stopChan:     make(chan struct{}),
	}
}

// Start starts the background worker
func (w *Worker) Start() {
	log.Println("Starting background worker...")
	go w.processJobs()
}

// Stop stops the background worker
func (w *Worker) Stop() {
	close(w.stopChan)
}

// processJobs continuously processes jobs in the background
func (w *Worker) processJobs() {
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.processActiveJobs()
		case <-w.stopChan:
			log.Println("Stopping background worker...")
			return
		}
	}
}

// processActiveJobs processes all active jobs
func (w *Worker) processActiveJobs() {
	jobs, err := w.db.GetActiveJobs()
	if err != nil {
		log.Printf("Error getting active jobs: %v", err)
		return
	}

	for _, job := range jobs {
		if err := w.processJob(job); err != nil {
			log.Printf("Error processing job %s: %v", job.ID, err)
			// Update job with error
			errMsg := err.Error()
			w.db.UpdateJobStatus(job.ID, "failed", &errMsg)
		}
	}
}

// processJob processes a single job
func (w *Worker) processJob(job *models.Job) error {
	ctx := context.Background()

	switch job.Status {
	case "uploaded":
		// Start Gemini batch processing
		return w.startGeminiProcessing(ctx, job)
	case "processing":
		// Check Gemini job status
		return w.checkGeminiStatus(ctx, job)
	default:
		return nil // Nothing to do
	}
}

// startGeminiProcessing starts the Gemini batch processing for a job
func (w *Worker) startGeminiProcessing(ctx context.Context, job *models.Job) error {
	log.Printf("Starting Gemini processing for job %s", job.ID)

	// Get all uploaded photos for this job
	photos, err := w.db.GetUploadedPhotosByJob(job.ID)
	if err != nil {
		return fmt.Errorf("failed to get uploaded photos: %w", err)
	}

	// Group photos by group_id
	photoGroups := make(map[string][]gemini.PhotoInfo)
	for _, photo := range photos {
		if photo.GroupID == nil || *photo.GroupID == "" {
			continue // Skip photos without groups
		}

		groupID := *photo.GroupID
		photoGroups[groupID] = append(photoGroups[groupID], gemini.PhotoInfo{
			ID:       photo.PhotoID,
			FilePath: photo.FilePath,
		})
	}

	// Create JSONL file for batch processing
	jsonlFile, err := w.geminiClient.CreateBatchJSONL(photoGroups, job.ID)
	if err != nil {
		return fmt.Errorf("failed to create batch JSONL: %w", err)
	}

	log.Printf("Created JSONL file: %s", jsonlFile)

	// Upload JSONL file to Gemini
	inputFileName, err := w.geminiClient.UploadBatchFile(ctx, jsonlFile)
	if err != nil {
		return fmt.Errorf("failed to upload batch file: %w", err)
	}

	log.Printf("Uploaded batch file: %s", inputFileName)

	// Create batch job in Gemini
	// Note: The Go SDK doesn't fully support batch API yet
	// For now, we'll use a placeholder job name
	// You may need to implement this using REST API directly
	displayName := fmt.Sprintf("lens-cleaner-%s", job.ID)
	geminiJobName := fmt.Sprintf("projects/*/locations/*/batchPredictionJobs/%s", uuid.New().String())

	// Update job with Gemini info
	if err := w.db.UpdateJobGeminiInfo(job.ID, geminiJobName, inputFileName); err != nil {
		return fmt.Errorf("failed to update job with Gemini info: %w", err)
	}

	log.Printf("Started Gemini batch job %s for job %s", geminiJobName, job.ID)

	// TODO: Actually create the batch job using Gemini REST API
	// This is a placeholder - you'll need to implement the actual API call
	log.Printf("WARNING: Gemini batch job creation not fully implemented. Job name: %s, Display name: %s", geminiJobName, displayName)

	return nil
}

// checkGeminiStatus checks the status of a Gemini batch job
func (w *Worker) checkGeminiStatus(ctx context.Context, job *models.Job) error {
	if job.GeminiJobName == nil {
		return fmt.Errorf("job has no Gemini job name")
	}

	log.Printf("Checking Gemini status for job %s", job.ID)

	// Check batch job status
	// Note: This is a placeholder - you'll need to implement using REST API
	status, outputFileName, err := w.geminiClient.CheckBatchJobStatus(ctx, *job.GeminiJobName)
	if err != nil {
		// If error is "not implemented", just log and return
		if err.Error() == "batch job status checking not yet implemented in Go SDK - use REST API" {
			log.Printf("Gemini batch status check not implemented: %v", err)
			return nil
		}
		return fmt.Errorf("failed to check batch status: %w", err)
	}

	switch status {
	case "completed", "SUCCEEDED":
		return w.processGeminiResults(ctx, job, outputFileName)
	case "failed", "FAILED":
		errMsg := "Gemini batch job failed"
		return w.db.UpdateJobStatus(job.ID, "failed", &errMsg)
	case "running", "PENDING", "RUNNING":
		// Still processing, nothing to do
		return nil
	default:
		log.Printf("Unknown Gemini job status: %s", status)
		return nil
	}
}

// processGeminiResults processes the results from a completed Gemini batch job
func (w *Worker) processGeminiResults(ctx context.Context, job *models.Job, outputFileName string) error {
	log.Printf("Processing Gemini results for job %s", job.ID)

	// Download results file
	resultsFile := fmt.Sprintf("batch_results_%s.jsonl", job.ID)
	if err := w.geminiClient.DownloadBatchResults(ctx, outputFileName, resultsFile); err != nil {
		// If not implemented, log and return
		log.Printf("Results download not fully implemented: %v", err)
		// For now, assume results file is already available
		// You'll need to implement actual download
	}

	// Parse results
	results, err := gemini.ParseBatchResults(resultsFile)
	if err != nil {
		return fmt.Errorf("failed to parse batch results: %w", err)
	}

	// Clear any existing results for this job
	if err := w.db.DeleteProcessingResultsByJob(job.ID); err != nil {
		return fmt.Errorf("failed to clear existing results: %w", err)
	}

	// Save results to database
	processedCount := 0
	for _, result := range results {
		for _, deletion := range result.Deletions {
			processingResult := &models.ProcessingResult{
				ID:           uuid.New().String(),
				JobID:        job.ID,
				PhotoID:      deletion.ID,
				GroupID:      "", // Will be filled from uploaded_photos
				ShouldDelete: true,
				Reason:       &deletion.Reason,
				Confidence:   deletion.Confidence,
				CreatedAt:    time.Now(),
			}

			// Get group ID from uploaded photos
			photo, err := w.db.GetUploadedPhotoByJobAndPhotoID(job.ID, deletion.ID)
			if err == nil && photo.GroupID != nil {
				processingResult.GroupID = *photo.GroupID
			}

			if err := w.db.CreateProcessingResult(processingResult); err != nil {
				log.Printf("Warning: failed to save processing result for photo %s: %v", deletion.ID, err)
				continue
			}
			processedCount++
		}
	}

	// Update job as completed
	if err := w.db.CompleteJob(job.ID, outputFileName); err != nil {
		return fmt.Errorf("failed to complete job: %w", err)
	}

	// Update processed photos count
	if err := w.db.UpdateJobProgress(job.ID, job.UploadedPhotos, processedCount); err != nil {
		log.Printf("Warning: failed to update job progress: %v", err)
	}

	log.Printf("Completed job %s with %d processing results", job.ID, processedCount)

	return nil
}
