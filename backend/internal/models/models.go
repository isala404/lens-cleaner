package models

import "time"

// Payment represents a payment record
type Payment struct {
	ID              string    `json:"id" db:"id"`
	UserID          string    `json:"user_id" db:"user_id"` // Can be email or session ID
	PhotoCount      int       `json:"photo_count" db:"photo_count"`
	AmountPaid      float64   `json:"amount_paid" db:"amount_paid"`
	Currency        string    `json:"currency" db:"currency"`
	PaymentProvider string    `json:"payment_provider" db:"payment_provider"` // polar.sh
	PaymentID       string    `json:"payment_id" db:"payment_id"`             // External payment ID
	Status          string    `json:"status" db:"status"`                     // pending, completed, failed, refunded
	CreatedAt       time.Time `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time `json:"updated_at" db:"updated_at"`
}

// Job represents a processing job
type Job struct {
	ID               string     `json:"id" db:"id"`
	PaymentID        string     `json:"payment_id" db:"payment_id"`
	UserID           string     `json:"user_id" db:"user_id"`
	Status           string     `json:"status" db:"status"` // created, uploading, uploaded, processing, completed, failed, cancelled
	TotalPhotos      int        `json:"total_photos" db:"total_photos"`
	UploadedPhotos   int        `json:"uploaded_photos" db:"uploaded_photos"`
	ProcessedPhotos  int        `json:"processed_photos" db:"processed_photos"`
	GeminiJobName    *string    `json:"gemini_job_name,omitempty" db:"gemini_job_name"`
	GeminiInputFile  *string    `json:"gemini_input_file,omitempty" db:"gemini_input_file"`
	GeminiOutputFile *string    `json:"gemini_output_file,omitempty" db:"gemini_output_file"`
	ErrorMessage     *string    `json:"error_message,omitempty" db:"error_message"`
	CreatedAt        time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at" db:"updated_at"`
	CompletedAt      *time.Time `json:"completed_at,omitempty" db:"completed_at"`
	GroupingDataHash string     `json:"grouping_data_hash" db:"grouping_data_hash"` // Hash of grouping JSON for validation
}

// UploadedPhoto represents a photo that has been uploaded
type UploadedPhoto struct {
	ID        string    `json:"id" db:"id"`
	JobID     string    `json:"job_id" db:"job_id"`
	PhotoID   string    `json:"photo_id" db:"photo_id"` // Original photo ID from frontend
	FilePath  string    `json:"file_path" db:"file_path"`
	GroupID   *string   `json:"group_id,omitempty" db:"group_id"`
	Uploaded  bool      `json:"uploaded" db:"uploaded"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

// ProcessingResult represents the AI analysis result for a photo
type ProcessingResult struct {
	ID           string    `json:"id" db:"id"`
	JobID        string    `json:"job_id" db:"job_id"`
	PhotoID      string    `json:"photo_id" db:"photo_id"`
	GroupID      string    `json:"group_id" db:"group_id"`
	ShouldDelete bool      `json:"should_delete" db:"should_delete"`
	Reason       *string   `json:"reason,omitempty" db:"reason"`
	Confidence   string    `json:"confidence" db:"confidence"` // high, medium, low
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
}

// Request/Response Models

// CostCalculationRequest represents the request to calculate cost
type CostCalculationRequest struct {
	PhotoCount int `json:"photo_count" binding:"required,min=1"`
}

// CostCalculationResponse represents the cost calculation response
type CostCalculationResponse struct {
	PhotoCount    int     `json:"photo_count"`
	TotalCost     float64 `json:"total_cost"`
	Currency      string  `json:"currency"`
	PricePerPhoto float64 `json:"price_per_photo"`
}

// CreateJobRequest represents the request to create a job after payment
type CreateJobRequest struct {
	PaymentID  string `json:"payment_id" binding:"required"`
	UserID     string `json:"user_id" binding:"required"`
	PhotoCount int    `json:"photo_count" binding:"required,min=1"`
}

// GroupingData represents the grouping information from frontend
type GroupingData struct {
	Groups map[string][]string `json:"groups" binding:"required"` // groupId -> []photoId
}

// SubmitGroupingRequest represents the request to submit grouping data
type SubmitGroupingRequest struct {
	JobID        string       `json:"job_id" binding:"required"`
	GroupingData GroupingData `json:"grouping_data" binding:"required"`
}

// JobStatusResponse represents the job status response
type JobStatusResponse struct {
	ID              string     `json:"id"`
	Status          string     `json:"status"`
	TotalPhotos     int        `json:"total_photos"`
	UploadedPhotos  int        `json:"uploaded_photos"`
	ProcessedPhotos int        `json:"processed_photos"`
	Progress        float64    `json:"progress"` // 0-100
	ErrorMessage    *string    `json:"error_message,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	EstimatedTime   *int       `json:"estimated_time,omitempty"` // seconds
}

// ResultsResponse represents the processing results
type ResultsResponse struct {
	JobID   string             `json:"job_id"`
	Results []ProcessingResult `json:"results"`
}

// GeminiDeletionSuggestion represents a single deletion suggestion from Gemini
type GeminiDeletionSuggestion struct {
	Index      int    `json:"index"`
	ID         string `json:"id"`
	Reason     string `json:"reason"`
	Confidence string `json:"confidence"` // high, medium, low
}

// GeminiResponse represents the structured response from Gemini
type GeminiResponse struct {
	Analysis  string                     `json:"analysis"`
	Deletions []GeminiDeletionSuggestion `json:"deletions"`
}
