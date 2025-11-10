package main

import (
	"log"
	"os"
	"strconv"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/isala404/lens-cleaner/backend/internal/api"
	"github.com/isala404/lens-cleaner/backend/internal/db"
	"github.com/isala404/lens-cleaner/backend/internal/gemini"
)

func main() {
	// Load environment variables
	port := getEnv("PORT", "8080")
	host := getEnv("HOST", "0.0.0.0")
	dbPath := getEnv("DATABASE_PATH", "./lens_cleaner.db")
	uploadDir := getEnv("UPLOAD_DIR", "./uploads")
	googleAPIKey := getEnv("GOOGLE_API_KEY", "")
	geminiModel := getEnv("GEMINI_MODEL", "gemini-2.0-flash-exp")

	pricePerPhoto, err := strconv.ParseFloat(getEnv("PRICE_PER_PHOTO", "0.01"), 64)
	if err != nil {
		log.Printf("Warning: Invalid PRICE_PER_PHOTO, using default 0.01: %v", err)
		pricePerPhoto = 0.01
	}
	tolerance, err := strconv.Atoi(getEnv("TOLERANCE", "10"))
	if err != nil {
		log.Printf("Warning: Invalid TOLERANCE, using default 10: %v", err)
		tolerance = 10
	}
	pollInterval, err := strconv.Atoi(getEnv("POLL_INTERVAL", "30"))
	if err != nil {
		log.Printf("Warning: Invalid POLL_INTERVAL, using default 30: %v", err)
		pollInterval = 30
	}

	// Initialize database
	database, err := db.New(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	log.Println("Database initialized successfully")

	// Initialize Gemini client
	var geminiClient *gemini.Client
	if googleAPIKey != "" {
		geminiClient, err = gemini.New(googleAPIKey, geminiModel)
		if err != nil {
			log.Fatalf("Failed to initialize Gemini client: %v", err)
		}
		defer geminiClient.Close()
		log.Println("Gemini client initialized successfully")
	} else {
		log.Println("WARNING: GOOGLE_API_KEY not set. Gemini processing will not be available.")
	}

	// Initialize API
	apiHandler := api.New(database, geminiClient, uploadDir, pricePerPhoto, tolerance)

	// Initialize and start background worker
	if geminiClient != nil {
		worker := api.NewWorker(database, geminiClient, time.Duration(pollInterval)*time.Second)
		worker.Start()
		defer worker.Stop()
		log.Printf("Background worker started (poll interval: %ds)", pollInterval)
	}

	// Setup Gin router
	router := gin.Default()

	// CORS configuration
	router.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"}, // In production, specify actual origins
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	// API routes
	v1 := router.Group("/api/v1")
	{
		// Health check
		v1.GET("/health", apiHandler.Health)

		// Cost calculation
		v1.POST("/cost/calculate", apiHandler.CalculateCost)

		// Payment
		v1.POST("/payments", apiHandler.CreatePayment)

		// Jobs
		v1.POST("/jobs", apiHandler.CreateJob)
		v1.GET("/jobs/:jobId/status", apiHandler.GetJobStatus)
		v1.GET("/jobs/:jobId/results", apiHandler.GetResults)

		// Photo upload
		v1.POST("/jobs/:jobId/upload", apiHandler.UploadPhoto)

		// Grouping
		v1.POST("/grouping/submit", apiHandler.SubmitGrouping)

		// Refund template
		v1.GET("/refund/template", apiHandler.GetRefundTemplate)
	}

	// Start server
	addr := host + ":" + port
	log.Printf("Starting server on %s", addr)
	if err := router.Run(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// getEnv gets an environment variable or returns a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
