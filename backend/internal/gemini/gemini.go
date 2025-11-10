package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/generative-ai-go/genai"
	"github.com/google/uuid"
	"github.com/isala404/lens-cleaner/backend/internal/models"
	"google.golang.org/api/option"
)

type Client struct {
	client    *genai.Client
	modelName string
}

// New creates a new Gemini client
func New(apiKey, modelName string) (*Client, error) {
	ctx := context.Background()
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}

	return &Client{
		client:    client,
		modelName: modelName,
	}, nil
}

// Close closes the Gemini client
func (c *Client) Close() error {
	return c.client.Close()
}

// BatchRequest represents a single request in the JSONL batch file
type BatchRequest struct {
	Request BatchRequestData `json:"request"`
}

// BatchRequestData contains the actual request data
type BatchRequestData struct {
	Contents         []Content        `json:"contents"`
	GenerationConfig GenerationConfig `json:"generation_config"`
}

// Content represents the content structure for Gemini
type Content struct {
	Parts []Part `json:"parts"`
}

// Part can be either text or inline data
type Part struct {
	Text       string      `json:"text,omitempty"`
	InlineData *InlineData `json:"inline_data,omitempty"`
}

// InlineData represents inline image data
type InlineData struct {
	MimeType string `json:"mime_type"`
	Data     string `json:"data"` // base64 encoded
}

// GenerationConfig represents the generation configuration
type GenerationConfig struct {
	Temperature      float32                `json:"temperature"`
	MaxOutputTokens  int                    `json:"max_output_tokens"`
	ResponseMimeType string                 `json:"responseMimeType"`
	ResponseSchema   map[string]interface{} `json:"responseSchema"`
}

// CreateBatchJSONL creates a JSONL file for batch processing
func (c *Client) CreateBatchJSONL(groups map[string][]PhotoInfo, jobID string) (string, error) {
	filename := fmt.Sprintf("batch_requests_%s.jsonl", jobID)
	file, err := os.Create(filename)
	if err != nil {
		return "", fmt.Errorf("failed to create JSONL file: %w", err)
	}
	defer file.Close()

	encoder := json.NewEncoder(file)

	systemPrompt := `You are an expert photo curator and digital asset manager with years of experience in identifying valuable photos versus redundant or low-quality images. Your task is to analyze groups of photos taken around the same time and identify which photos should be marked for deletion.

EVALUATION CRITERIA:

1. DUPLICATES & SIMILARITY:
   - Identify photos that are essentially the same shot (same pose, angle, composition)
   - Keep the best quality version (sharpest, best exposure, best composition)
   - Consider slight variations in pose/expression - keep the best one

2. TECHNICAL QUALITY:
   - Mark blurry, out-of-focus, or motion-blurred photos for deletion
   - Identify photos with poor exposure (too dark, too bright, blown highlights)
   - Flag photos with poor composition (subject cut off, tilted horizon, etc.)

3. ARTISTIC & EMOTIONAL VALUE:
   - Preserve photos with unique artistic merit (interesting angles, lighting, composition)
   - Keep photos capturing genuine emotions or special moments
   - Preserve photos that tell a story or capture a unique perspective
   - Consider historical/documentary value for family memories

4. HUMAN ELEMENTS:
   - Delete photos where people have their eyes closed, unflattering expressions
   - Keep photos with natural, genuine expressions and good poses
   - Consider group dynamics - prefer photos where everyone looks good

5. SPECIAL CONSIDERATIONS:
   - Test shots, accidental photos, finger-over-lens should be deleted
   - Screenshots, memes, or non-personal content can usually be deleted
   - Photos of text/documents - keep only if they have ongoing value
   - Landscape/travel photos - preserve unique views, delete redundant angles

DECISION FRAMEWORK:
- If photos are very similar, keep only the best 1-2 versions
- If a photo has ANY unique value (emotional, artistic, documentary), preserve it
- When in doubt between two similar photos, preserve both rather than risk losing memories
- Only mark photos for deletion if they are clearly redundant or have significant quality issues

Be conservative - it's better to keep a questionable photo than to lose an irreplaceable memory.`

	responseSchema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"analysis": map[string]interface{}{"type": "string"},
			"deletions": map[string]interface{}{
				"type": "array",
				"items": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"index":  map[string]interface{}{"type": "integer"},
						"id":     map[string]interface{}{"type": "string"},
						"reason": map[string]interface{}{"type": "string"},
						"confidence": map[string]interface{}{
							"type": "string",
							"enum": []string{"high", "medium", "low"},
						},
					},
					"required": []string{"index", "id", "reason", "confidence"},
				},
			},
		},
		"required": []string{"analysis", "deletions"},
	}

	for groupID, photos := range groups {
		if len(photos) <= 1 {
			continue // Skip single photo groups
		}

		parts := []Part{
			{Text: systemPrompt},
		}

		// Add photos to the request
		for i, photo := range photos {
			parts = append(parts, Part{
				Text: fmt.Sprintf("Photo id: %s, index: %d, group_id: %s", photo.ID, i, groupID),
			})

			// Read image file and encode to base64
			imageData, err := os.ReadFile(photo.FilePath)
			if err != nil {
				return "", fmt.Errorf("failed to read image %s: %w", photo.FilePath, err)
			}

			parts = append(parts, Part{
				InlineData: &InlineData{
					MimeType: "image/jpeg",
					Data:     string(imageData), // Will be base64 encoded by Gemini client
				},
			})
		}

		parts = append(parts, Part{
			Text: fmt.Sprintf("Please analyze this group of %d photos and identify which ones should be marked for deletion based on the criteria above. Always start the analysis with 'In Group %s,'", len(photos), groupID),
		})

		request := BatchRequest{
			Request: BatchRequestData{
				Contents: []Content{
					{Parts: parts},
				},
				GenerationConfig: GenerationConfig{
					Temperature:      0.1,
					MaxOutputTokens:  4096,
					ResponseMimeType: "application/json",
					ResponseSchema:   responseSchema,
				},
			},
		}

		if err := encoder.Encode(request); err != nil {
			return "", fmt.Errorf("failed to encode request: %w", err)
		}
	}

	return filename, nil
}

// PhotoInfo contains photo information for batch processing
type PhotoInfo struct {
	ID       string
	FilePath string
}

// UploadBatchFile uploads a JSONL file to Gemini
func (c *Client) UploadBatchFile(ctx context.Context, filePath string) (string, error) {
	file, err := c.client.UploadFileFromPath(ctx, filePath, nil)
	if err != nil {
		return "", fmt.Errorf("failed to upload file: %w", err)
	}

	// Wait for file to be processed
	for file.State == genai.FileStateProcessing {
		time.Sleep(2 * time.Second)
		file, err = c.client.GetFile(ctx, file.Name)
		if err != nil {
			return "", fmt.Errorf("failed to get file status: %w", err)
		}
	}

	if file.State != genai.FileStateActive {
		return "", fmt.Errorf("uploaded file is not active: %s", file.State)
	}

	return file.Name, nil
}

// CreateBatchJob creates a batch job in Gemini
func (c *Client) CreateBatchJob(ctx context.Context, inputFileName, displayName string) (string, error) {
	// Note: The Google Gemini Go SDK doesn't have direct batch API support yet
	// This is a placeholder - you may need to use the REST API directly
	// For now, we'll return an error indicating this needs to be implemented
	return "", fmt.Errorf("batch job creation not yet implemented in Go SDK - use REST API")
}

// CheckBatchJobStatus checks the status of a batch job
func (c *Client) CheckBatchJobStatus(ctx context.Context, jobName string) (string, string, error) {
	// Placeholder for batch job status checking
	// Returns: status, outputFileName, error
	return "", "", fmt.Errorf("batch job status checking not yet implemented in Go SDK - use REST API")
}

// DownloadBatchResults downloads the results file
func (c *Client) DownloadBatchResults(ctx context.Context, fileName, outputPath string) error {
	file, err := c.client.GetFile(ctx, fileName)
	if err != nil {
		return fmt.Errorf("failed to get file: %w", err)
	}

	// Download file content
	// Note: The Go SDK may not have direct download support
	// You might need to use the REST API or file.URI
	return fmt.Errorf("file download not yet implemented in Go SDK - use file URI: %s", file.URI)
}

// ParseBatchResults parses the JSONL results file
func ParseBatchResults(filePath string) ([]models.GeminiResponse, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open results file: %w", err)
	}
	defer file.Close()

	var results []models.GeminiResponse
	decoder := json.NewDecoder(file)

	for decoder.More() {
		var batchResponse struct {
			Response struct {
				Candidates []struct {
					Content struct {
						Parts []struct {
							Text string `json:"text"`
						} `json:"parts"`
					} `json:"content"`
					FinishReason string `json:"finishReason"`
				} `json:"candidates"`
			} `json:"response"`
		}

		if err := decoder.Decode(&batchResponse); err != nil {
			continue // Skip malformed lines
		}

		if len(batchResponse.Response.Candidates) == 0 {
			continue
		}

		candidate := batchResponse.Response.Candidates[0]
		if candidate.FinishReason == "MAX_TOKENS" {
			continue // Skip truncated responses
		}

		if len(candidate.Content.Parts) == 0 {
			continue
		}

		// Parse the JSON response
		var geminiResp models.GeminiResponse
		if err := json.Unmarshal([]byte(candidate.Content.Parts[0].Text), &geminiResp); err != nil {
			continue // Skip malformed JSON
		}

		results = append(results, geminiResp)
	}

	return results, nil
}

// GenerateBatchID generates a unique batch ID
func GenerateBatchID() string {
	return uuid.New().String()
}

// GetBatchFilePath returns the path for a batch file
func GetBatchFilePath(jobID, fileType string) string {
	return filepath.Join(".", fmt.Sprintf("batch_%s_%s.jsonl", fileType, jobID))
}
