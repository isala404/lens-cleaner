package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/isala404/lens-cleaner/backend/internal/db"
	"github.com/isala404/lens-cleaner/backend/internal/gemini"
	"github.com/isala404/lens-cleaner/backend/internal/models"
)

type API struct {
	db            *db.Database
	geminiClient  *gemini.Client
	uploadDir     string
	pricePerPhoto float64
	tolerance     int
}

// New creates a new API instance
func New(database *db.Database, geminiClient *gemini.Client, uploadDir string, pricePerPhoto float64, tolerance int) *API {
	// Ensure upload directory exists
	os.MkdirAll(uploadDir, 0755)

	return &API{
		db:            database,
		geminiClient:  geminiClient,
		uploadDir:     uploadDir,
		pricePerPhoto: pricePerPhoto,
		tolerance:     tolerance,
	}
}

// CalculateCost calculates the cost for processing photos
func (a *API) CalculateCost(c *gin.Context) {
	var req models.CostCalculationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	totalCost := float64(req.PhotoCount) * a.pricePerPhoto

	c.JSON(http.StatusOK, models.CostCalculationResponse{
		PhotoCount:    req.PhotoCount,
		TotalCost:     totalCost,
		Currency:      "USD",
		PricePerPhoto: a.pricePerPhoto,
	})
}

// CreateJob creates a new processing job after payment
func (a *API) CreateJob(c *gin.Context) {
	var req models.CreateJobRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify payment exists and is completed
	payment, err := a.db.GetPayment(req.PaymentID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "payment not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get payment"})
		return
	}

	if payment.Status != "completed" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payment not completed"})
		return
	}

	if payment.PhotoCount < req.PhotoCount {
		c.JSON(http.StatusBadRequest, gin.H{"error": "photo count exceeds paid amount"})
		return
	}

	// Create job
	job := &models.Job{
		ID:          uuid.New().String(),
		PaymentID:   req.PaymentID,
		UserID:      req.UserID,
		Status:      "created",
		TotalPhotos: req.PhotoCount,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	if err := a.db.CreateJob(job); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create job"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"job_id": job.ID,
		"status": job.Status,
	})
}

// UploadPhoto handles individual photo upload
func (a *API) UploadPhoto(c *gin.Context) {
	jobID := c.Param("jobId")
	photoID := c.PostForm("photo_id")

	if photoID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "photo_id is required"})
		return
	}

	// Get job
	job, err := a.db.GetJob(jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get job"})
		return
	}

	// Check if job is in correct status
	if job.Status != "created" && job.Status != "uploading" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job is not in uploading state"})
		return
	}

	// Update job status to uploading if it's created
	if job.Status == "created" {
		if err := a.db.UpdateJobStatus(jobID, "uploading", nil); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update job status"})
			return
		}
	}

	// Check if photo already uploaded (for resume support)
	existingPhoto, err := a.db.GetUploadedPhotoByJobAndPhotoID(jobID, photoID)
	if err == nil && existingPhoto != nil && existingPhoto.Uploaded {
		c.JSON(http.StatusOK, gin.H{
			"photo_id": photoID,
			"status":   "already_uploaded",
		})
		return
	}

	// Get uploaded file
	file, err := c.FormFile("photo")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "photo file is required"})
		return
	}

	// Create job-specific upload directory
	jobUploadDir := filepath.Join(a.uploadDir, jobID)
	if err := os.MkdirAll(jobUploadDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create upload directory"})
		return
	}

	// Save file
	filename := fmt.Sprintf("%s%s", photoID, filepath.Ext(file.Filename))
	filePath := filepath.Join(jobUploadDir, filename)

	if err := c.SaveUploadedFile(file, filePath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}

	// Save to database
	uploadedPhoto := &models.UploadedPhoto{
		ID:        uuid.New().String(),
		JobID:     jobID,
		PhotoID:   photoID,
		FilePath:  filePath,
		Uploaded:  true,
		CreatedAt: time.Now(),
	}

	if err := a.db.CreateUploadedPhoto(uploadedPhoto); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save photo record"})
		return
	}

	// Update job progress
	uploadedPhotos := job.UploadedPhotos + 1
	if err := a.db.UpdateJobProgress(jobID, uploadedPhotos, job.ProcessedPhotos); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update job progress"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"photo_id":        photoID,
		"status":          "uploaded",
		"uploaded_count":  uploadedPhotos,
		"total_count":     job.TotalPhotos,
	})
}

// SubmitGrouping submits the grouping data and starts processing
func (a *API) SubmitGrouping(c *gin.Context) {
	var req models.SubmitGroupingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get job
	job, err := a.db.GetJob(req.JobID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get job"})
		return
	}

	// Validate status
	if job.Status != "uploading" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job is not in uploading state"})
		return
	}

	// Count total photos in grouping data
	totalPhotosInGroups := 0
	for _, photoIDs := range req.GroupingData.Groups {
		totalPhotosInGroups += len(photoIDs)
	}

	// Get payment to check allowed count
	payment, err := a.db.GetPayment(job.PaymentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get payment"})
		return
	}

	// Check if total photos exceeds paid amount + tolerance
	if totalPhotosInGroups > payment.PhotoCount+a.tolerance {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("Total photos (%d) exceeds paid amount (%d + %d tolerance). Please contact support at refunds@tallisa.dev",
				totalPhotosInGroups, payment.PhotoCount, a.tolerance),
			"total_photos": totalPhotosInGroups,
			"paid_amount":  payment.PhotoCount,
			"tolerance":    a.tolerance,
		})
		return
	}

	// Calculate hash of grouping data for validation
	groupingJSON, _ := json.Marshal(req.GroupingData)
	hash := sha256.Sum256(groupingJSON)
	groupingDataHash := hex.EncodeToString(hash[:])

	// Update uploaded photos with group IDs
	for groupID, photoIDs := range req.GroupingData.Groups {
		for _, photoID := range photoIDs {
			if err := a.db.UpdatePhotoGroupID(req.JobID, photoID, groupID); err != nil {
				// Log error but continue
				fmt.Printf("Warning: failed to update group ID for photo %s: %v\n", photoID, err)
			}
		}
	}

	// Update job with grouping data hash
	if err := a.db.UpdateJobStatus(req.JobID, "uploaded", nil); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update job status"})
		return
	}

	// Note: The actual Gemini processing will be done by a background worker
	// We just mark the job as ready for processing here

	c.JSON(http.StatusOK, gin.H{
		"job_id":       req.JobID,
		"status":       "uploaded",
		"total_photos": totalPhotosInGroups,
		"message":      "Grouping data submitted successfully. Processing will start shortly.",
	})
}

// GetJobStatus returns the current status of a job
func (a *API) GetJobStatus(c *gin.Context) {
	jobID := c.Param("jobId")

	job, err := a.db.GetJob(jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get job"})
		return
	}

	// Calculate progress
	progress := 0.0
	if job.TotalPhotos > 0 {
		if job.Status == "uploading" || job.Status == "created" {
			progress = float64(job.UploadedPhotos) / float64(job.TotalPhotos) * 50 // 0-50% for uploading
		} else if job.Status == "processing" {
			progress = 50 + (float64(job.ProcessedPhotos)/float64(job.TotalPhotos))*50 // 50-100% for processing
		} else if job.Status == "completed" {
			progress = 100
		}
	}

	// Estimate time remaining (rough estimate: 2 seconds per photo for processing)
	var estimatedTime *int
	if job.Status == "processing" && job.ProcessedPhotos < job.TotalPhotos {
		remaining := (job.TotalPhotos - job.ProcessedPhotos) * 2
		estimatedTime = &remaining
	}

	response := models.JobStatusResponse{
		ID:              job.ID,
		Status:          job.Status,
		TotalPhotos:     job.TotalPhotos,
		UploadedPhotos:  job.UploadedPhotos,
		ProcessedPhotos: job.ProcessedPhotos,
		Progress:        progress,
		ErrorMessage:    job.ErrorMessage,
		CompletedAt:     job.CompletedAt,
		EstimatedTime:   estimatedTime,
	}

	c.JSON(http.StatusOK, response)
}

// GetResults returns the processing results for a completed job
func (a *API) GetResults(c *gin.Context) {
	jobID := c.Param("jobId")

	job, err := a.db.GetJob(jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get job"})
		return
	}

	if job.Status != "completed" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job is not completed yet"})
		return
	}

	results, err := a.db.GetProcessingResultsByJob(jobID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get results"})
		return
	}

	c.JSON(http.StatusOK, models.ResultsResponse{
		JobID:   jobID,
		Results: convertResultsSlice(results),
	})
}

// Helper function to convert []*ProcessingResult to []ProcessingResult
func convertResultsSlice(results []*models.ProcessingResult) []models.ProcessingResult {
	converted := make([]models.ProcessingResult, len(results))
	for i, r := range results {
		converted[i] = *r
	}
	return converted
}

// CreatePayment creates a payment record (called after successful payment via Polar)
func (a *API) CreatePayment(c *gin.Context) {
	var req struct {
		UserID         string  `json:"user_id" binding:"required"`
		PhotoCount     int     `json:"photo_count" binding:"required,min=1"`
		AmountPaid     float64 `json:"amount_paid" binding:"required,min=0"`
		PaymentID      string  `json:"payment_id" binding:"required"`
		PaymentProvider string `json:"payment_provider" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	payment := &models.Payment{
		ID:              uuid.New().String(),
		UserID:          req.UserID,
		PhotoCount:      req.PhotoCount,
		AmountPaid:      req.AmountPaid,
		Currency:        "USD",
		PaymentProvider: req.PaymentProvider,
		PaymentID:       req.PaymentID,
		Status:          "completed",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}

	if err := a.db.CreatePayment(payment); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create payment"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"payment_id": payment.ID,
		"status":     payment.Status,
	})
}

// GetRefundTemplate returns the refund email template
func (a *API) GetRefundTemplate(c *gin.Context) {
	jobID := c.Query("job_id")
	userEmail := c.Query("email")

	if jobID == "" || userEmail == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_id and email are required"})
		return
	}

	job, err := a.db.GetJob(jobID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get job"})
		return
	}

	payment, err := a.db.GetPayment(job.PaymentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get payment"})
		return
	}

	// Calculate unused credits
	usedPhotos := job.ProcessedPhotos
	if job.Status == "completed" {
		// For completed jobs, count actual deletions suggested
		results, err := a.db.GetProcessingResultsByJob(jobID)
		if err == nil {
			usedPhotos = len(results)
		}
	}

	unusedPhotos := payment.PhotoCount - usedPhotos
	if unusedPhotos < 0 {
		unusedPhotos = 0
	}

	refundAmount := float64(unusedPhotos) * a.pricePerPhoto

	subject := fmt.Sprintf("Refund Request for Job %s", jobID)
	body := fmt.Sprintf(`Dear Lens Cleaner Support,

I would like to request a refund for unused credits from my photo processing job.

Job Details:
- Job ID: %s
- Payment ID: %s
- Total Photos Paid: %d
- Photos Processed: %d
- Unused Credits: %d photos
- Refund Amount: $%.2f USD

User Information:
- Email: %s

Please process this refund to my original payment method.

Thank you,
%s`, jobID, payment.PaymentID, payment.PhotoCount, usedPhotos, unusedPhotos, refundAmount, userEmail, userEmail)

	c.JSON(http.StatusOK, gin.H{
		"subject":       subject,
		"body":          body,
		"to":            "refunds@tallisa.dev",
		"unused_photos": unusedPhotos,
		"refund_amount": refundAmount,
		"mailto_link":   fmt.Sprintf("mailto:refunds@tallisa.dev?subject=%s&body=%s",
			http.StatusText(http.StatusOK), // URL encode these in frontend
			http.StatusText(http.StatusOK)),
	})
}

// Health check endpoint
func (a *API) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "healthy",
		"time":   time.Now().Format(time.RFC3339),
	})
}
