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
 * Upload a single photo for a job (atomic upload)
 */
export async function uploadPhoto(jobId: string, photo: File): Promise<void> {
	const formData = new FormData();
	formData.append('file', photo);

	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}/upload`, {
		method: 'POST',
		body: formData
	});

	if (!response.ok) {
		throw new Error(`Failed to upload photo: ${response.statusText}`);
	}
}

/**
 * Upload multiple photos with atomic requests (5 concurrent at a time)
 */
export async function uploadPhotos(
	jobId: string,
	photos: File[],
	onProgress?: (uploaded: number, total: number) => void
): Promise<void> {
	const CONCURRENT_UPLOADS = 5;
	let uploadedCount = 0;

	// Process in batches of 5 concurrent uploads
	for (let i = 0; i < photos.length; i += CONCURRENT_UPLOADS) {
		const batch = photos.slice(i, i + CONCURRENT_UPLOADS);
		const uploadPromises = batch.map((photo) => uploadPhoto(jobId, photo));

		await Promise.all(uploadPromises);

		uploadedCount += batch.length;
		if (onProgress) {
			onProgress(uploadedCount, photos.length);
		}
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
