/**
 * API Client for Lens Cleaner Backend
 * Handles communication with the Python FastAPI backend
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export interface CheckoutResponse {
	checkout_url: string;
	checkout_id: string;
	total_cost: number;
}

export interface JobStatusResponse {
	job_id: string;
	status: string;
	email: string;
	photo_count: number;
	created_at: string;
	completed_at?: string;
	results?: {
		deletions: Array<{
			photo_id: string;
			reason: string;
			confidence: 'high' | 'medium' | 'low';
		}>;
	};
}

/**
 * Create a checkout session
 */
export async function createCheckout(email: string, photoCount: number): Promise<CheckoutResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/checkout`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			email,
			photo_count: photoCount
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to create checkout: ${response.statusText}`);
	}

	return response.json();
}

/**
 * Upload photos for a job
 */
export async function uploadPhotos(jobId: string, photos: File[]): Promise<void> {
	const formData = new FormData();

	photos.forEach((photo) => {
		formData.append('files', photo);
	});

	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}/upload`, {
		method: 'POST',
		body: formData
	});

	if (!response.ok) {
		throw new Error(`Failed to upload photos: ${response.statusText}`);
	}
}

/**
 * Start processing a job
 */
export async function startProcessing(
	jobId: string,
	photoMetadata: Array<{ id: string; filename: string; group_id: string | null }>
): Promise<void> {
	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(photoMetadata)
	});

	if (!response.ok) {
		throw new Error(`Failed to start processing: ${response.statusText}`);
	}
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}`, {
		method: 'GET'
	});

	if (!response.ok && response.status !== 202) {
		throw new Error(`Failed to get job status: ${response.statusText}`);
	}

	return response.json();
}
