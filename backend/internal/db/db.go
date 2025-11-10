package db

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/isala404/lens-cleaner/backend/internal/models"
	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

type Database struct {
	db *sql.DB
}

// New creates a new database connection
func New(dbPath string) (*Database, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Enable WAL mode for better concurrency
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Set busy timeout
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}

	database := &Database{db: db}
	if err := database.initSchema(); err != nil {
		return nil, fmt.Errorf("failed to initialize schema: %w", err)
	}

	return database, nil
}

// Close closes the database connection
func (d *Database) Close() error {
	return d.db.Close()
}

// initSchema creates the database tables
func (d *Database) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS payments (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		photo_count INTEGER NOT NULL,
		amount_paid REAL NOT NULL,
		currency TEXT NOT NULL DEFAULT 'USD',
		payment_provider TEXT NOT NULL,
		payment_id TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
	CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id);
	CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		payment_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'created',
		total_photos INTEGER NOT NULL DEFAULT 0,
		uploaded_photos INTEGER NOT NULL DEFAULT 0,
		processed_photos INTEGER NOT NULL DEFAULT 0,
		gemini_job_name TEXT,
		gemini_input_file TEXT,
		gemini_output_file TEXT,
		error_message TEXT,
		grouping_data_hash TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		completed_at TIMESTAMP,
		FOREIGN KEY (payment_id) REFERENCES payments(id)
	);

	CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
	CREATE INDEX IF NOT EXISTS idx_jobs_payment_id ON jobs(payment_id);
	CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

	CREATE TABLE IF NOT EXISTS uploaded_photos (
		id TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		photo_id TEXT NOT NULL,
		file_path TEXT NOT NULL,
		group_id TEXT,
		uploaded BOOLEAN NOT NULL DEFAULT 0,
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (job_id) REFERENCES jobs(id)
	);

	CREATE INDEX IF NOT EXISTS idx_uploaded_photos_job_id ON uploaded_photos(job_id);
	CREATE INDEX IF NOT EXISTS idx_uploaded_photos_photo_id ON uploaded_photos(photo_id);
	CREATE INDEX IF NOT EXISTS idx_uploaded_photos_group_id ON uploaded_photos(group_id);

	CREATE TABLE IF NOT EXISTS processing_results (
		id TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		photo_id TEXT NOT NULL,
		group_id TEXT NOT NULL,
		should_delete BOOLEAN NOT NULL DEFAULT 0,
		reason TEXT,
		confidence TEXT NOT NULL,
		created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (job_id) REFERENCES jobs(id)
	);

	CREATE INDEX IF NOT EXISTS idx_processing_results_job_id ON processing_results(job_id);
	CREATE INDEX IF NOT EXISTS idx_processing_results_photo_id ON processing_results(photo_id);
	`

	_, err := d.db.Exec(schema)
	return err
}

// Payment methods

func (d *Database) CreatePayment(payment *models.Payment) error {
	query := `
		INSERT INTO payments (id, user_id, photo_count, amount_paid, currency, payment_provider, payment_id, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query,
		payment.ID,
		payment.UserID,
		payment.PhotoCount,
		payment.AmountPaid,
		payment.Currency,
		payment.PaymentProvider,
		payment.PaymentID,
		payment.Status,
		payment.CreatedAt,
		payment.UpdatedAt,
	)
	return err
}

func (d *Database) GetPayment(id string) (*models.Payment, error) {
	payment := &models.Payment{}
	query := `SELECT id, user_id, photo_count, amount_paid, currency, payment_provider, payment_id, status, created_at, updated_at FROM payments WHERE id = ?`
	err := d.db.QueryRow(query, id).Scan(
		&payment.ID,
		&payment.UserID,
		&payment.PhotoCount,
		&payment.AmountPaid,
		&payment.Currency,
		&payment.PaymentProvider,
		&payment.PaymentID,
		&payment.Status,
		&payment.CreatedAt,
		&payment.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return payment, nil
}

func (d *Database) UpdatePaymentStatus(id, status string) error {
	query := `UPDATE payments SET status = ?, updated_at = ? WHERE id = ?`
	_, err := d.db.Exec(query, status, time.Now(), id)
	return err
}

// Job methods

func (d *Database) CreateJob(job *models.Job) error {
	query := `
		INSERT INTO jobs (id, payment_id, user_id, status, total_photos, grouping_data_hash, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query,
		job.ID,
		job.PaymentID,
		job.UserID,
		job.Status,
		job.TotalPhotos,
		job.GroupingDataHash,
		job.CreatedAt,
		job.UpdatedAt,
	)
	return err
}

func (d *Database) GetJob(id string) (*models.Job, error) {
	job := &models.Job{}
	query := `
		SELECT id, payment_id, user_id, status, total_photos, uploaded_photos, processed_photos,
		       gemini_job_name, gemini_input_file, gemini_output_file, error_message,
		       grouping_data_hash, created_at, updated_at, completed_at
		FROM jobs WHERE id = ?
	`
	err := d.db.QueryRow(query, id).Scan(
		&job.ID,
		&job.PaymentID,
		&job.UserID,
		&job.Status,
		&job.TotalPhotos,
		&job.UploadedPhotos,
		&job.ProcessedPhotos,
		&job.GeminiJobName,
		&job.GeminiInputFile,
		&job.GeminiOutputFile,
		&job.ErrorMessage,
		&job.GroupingDataHash,
		&job.CreatedAt,
		&job.UpdatedAt,
		&job.CompletedAt,
	)
	if err != nil {
		return nil, err
	}
	return job, nil
}

func (d *Database) UpdateJobStatus(id, status string, errorMessage *string) error {
	query := `UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`
	_, err := d.db.Exec(query, status, errorMessage, time.Now(), id)
	return err
}

func (d *Database) UpdateJobProgress(id string, uploadedPhotos, processedPhotos int) error {
	query := `UPDATE jobs SET uploaded_photos = ?, processed_photos = ?, updated_at = ? WHERE id = ?`
	_, err := d.db.Exec(query, uploadedPhotos, processedPhotos, time.Now(), id)
	return err
}

func (d *Database) UpdateJobGeminiInfo(id, jobName, inputFile string) error {
	query := `UPDATE jobs SET gemini_job_name = ?, gemini_input_file = ?, status = ?, updated_at = ? WHERE id = ?`
	_, err := d.db.Exec(query, jobName, inputFile, "processing", time.Now(), id)
	return err
}

func (d *Database) CompleteJob(id, outputFile string) error {
	now := time.Now()
	query := `UPDATE jobs SET status = ?, gemini_output_file = ?, completed_at = ?, updated_at = ? WHERE id = ?`
	_, err := d.db.Exec(query, "completed", outputFile, now, now, id)
	return err
}

func (d *Database) GetActiveJobs() ([]*models.Job, error) {
	query := `
		SELECT id, payment_id, user_id, status, total_photos, uploaded_photos, processed_photos,
		       gemini_job_name, gemini_input_file, gemini_output_file, error_message,
		       grouping_data_hash, created_at, updated_at, completed_at
		FROM jobs
		WHERE status IN ('processing', 'uploaded')
		ORDER BY created_at ASC
	`
	rows, err := d.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []*models.Job
	for rows.Next() {
		job := &models.Job{}
		err := rows.Scan(
			&job.ID,
			&job.PaymentID,
			&job.UserID,
			&job.Status,
			&job.TotalPhotos,
			&job.UploadedPhotos,
			&job.ProcessedPhotos,
			&job.GeminiJobName,
			&job.GeminiInputFile,
			&job.GeminiOutputFile,
			&job.ErrorMessage,
			&job.GroupingDataHash,
			&job.CreatedAt,
			&job.UpdatedAt,
			&job.CompletedAt,
		)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

// UploadedPhoto methods

func (d *Database) CreateUploadedPhoto(photo *models.UploadedPhoto) error {
	query := `
		INSERT INTO uploaded_photos (id, job_id, photo_id, file_path, group_id, uploaded, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query,
		photo.ID,
		photo.JobID,
		photo.PhotoID,
		photo.FilePath,
		photo.GroupID,
		photo.Uploaded,
		photo.CreatedAt,
	)
	return err
}

func (d *Database) GetUploadedPhotosByJob(jobID string) ([]*models.UploadedPhoto, error) {
	query := `SELECT id, job_id, photo_id, file_path, group_id, uploaded, created_at FROM uploaded_photos WHERE job_id = ? ORDER BY created_at`
	rows, err := d.db.Query(query, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var photos []*models.UploadedPhoto
	for rows.Next() {
		photo := &models.UploadedPhoto{}
		err := rows.Scan(
			&photo.ID,
			&photo.JobID,
			&photo.PhotoID,
			&photo.FilePath,
			&photo.GroupID,
			&photo.Uploaded,
			&photo.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		photos = append(photos, photo)
	}
	return photos, rows.Err()
}

func (d *Database) GetUploadedPhotoByJobAndPhotoID(jobID, photoID string) (*models.UploadedPhoto, error) {
	photo := &models.UploadedPhoto{}
	query := `SELECT id, job_id, photo_id, file_path, group_id, uploaded, created_at FROM uploaded_photos WHERE job_id = ? AND photo_id = ?`
	err := d.db.QueryRow(query, jobID, photoID).Scan(
		&photo.ID,
		&photo.JobID,
		&photo.PhotoID,
		&photo.FilePath,
		&photo.GroupID,
		&photo.Uploaded,
		&photo.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return photo, nil
}

func (d *Database) UpdatePhotoGroupID(jobID, photoID, groupID string) error {
	query := `UPDATE uploaded_photos SET group_id = ? WHERE job_id = ? AND photo_id = ?`
	_, err := d.db.Exec(query, groupID, jobID, photoID)
	return err
}

// ProcessingResult methods

func (d *Database) CreateProcessingResult(result *models.ProcessingResult) error {
	query := `
		INSERT INTO processing_results (id, job_id, photo_id, group_id, should_delete, reason, confidence, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query,
		result.ID,
		result.JobID,
		result.PhotoID,
		result.GroupID,
		result.ShouldDelete,
		result.Reason,
		result.Confidence,
		result.CreatedAt,
	)
	return err
}

func (d *Database) GetProcessingResultsByJob(jobID string) ([]*models.ProcessingResult, error) {
	query := `SELECT id, job_id, photo_id, group_id, should_delete, reason, confidence, created_at FROM processing_results WHERE job_id = ?`
	rows, err := d.db.Query(query, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*models.ProcessingResult
	for rows.Next() {
		result := &models.ProcessingResult{}
		err := rows.Scan(
			&result.ID,
			&result.JobID,
			&result.PhotoID,
			&result.GroupID,
			&result.ShouldDelete,
			&result.Reason,
			&result.Confidence,
			&result.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func (d *Database) DeleteProcessingResultsByJob(jobID string) error {
	query := `DELETE FROM processing_results WHERE job_id = ?`
	_, err := d.db.Exec(query, jobID)
	return err
}
