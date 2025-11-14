/**
 * API Client for Lens Cleaner Backend
 * Handles communication with the Python FastAPI backend
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export interface PricingResponse {
	photo_count: number;
	charged_photos: number;
	total_cost: number;
	amount_in_cents: number;
	is_free: boolean;
	volume_limited?: boolean;
	volume_limit?: number;
	sales_email?: string;
}

export interface CheckoutResponse {
	checkout_url: string;
	checkout_id: string;
	job_id: string;
	total_photos: number;
	charged_photos: number;
	total_cost: number;
	amount_warning: string;
}

export interface PaymentVerificationResponse {
	job_id: string;
	payment_verified: boolean;
	photo_count: number;
	charged_photo_count: number;
	support_email: string;
	status?: string;
}

export interface JobStatusResponse {
	job_id: string;
	status: string;
	photo_count: number;
	charged_photo_count: number;
	created_at: string;
	completed_at?: string;
	payment_verified: boolean;
	amount_tampered: boolean;
	expected_amount?: number;
	actual_amount?: number;
	results?: {
		deletions: Array<{
			photo_id: string;
			reason: string;
			confidence: 'high' | 'medium' | 'low';
		}>;
	};
}

export interface RefundResponse {
	success: boolean;
	message: string;
	refund_id?: string;
}

/**
 * Calculate pricing for a given number of photos
 */
export async function calculatePricing(photoCount: number): Promise<PricingResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/pricing`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			photo_count: photoCount
		})
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to calculate pricing: ${errorText}`);
	}

	return response.json();
}

/**
 * Create a checkout session with Polar
 */
export async function createCheckout(photoCount: number): Promise<CheckoutResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/checkout`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			photo_count: photoCount
		})
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to create checkout: ${errorText}`);
	}

	return response.json();
}

/**
 * Verify payment with Polar after checkout
 */
export async function verifyPayment(checkoutId: string): Promise<PaymentVerificationResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/checkout/${checkoutId}/verify`, {
		method: 'GET'
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to verify payment: ${errorText}`);
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
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to upload photo: ${errorText}`);
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
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to start processing: ${errorText}`);
	}
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}`, {
		method: 'GET'
	});

	if (!response.ok && response.status !== 202 && response.status !== 500) {
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to get job status (${response.status}): ${errorText}`);
	}

	// For failed jobs (status 500), still return the response body
	if (response.status === 500) {
		const data = await response.json();
		return data;
	}

	return response.json();
}

/**
 * Process a refund for a failed job
 */
export async function refundJob(jobId: string): Promise<RefundResponse> {
	const response = await fetch(`${API_BASE_URL}/v1/api/job/${jobId}/refund`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		}
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => response.statusText);
		throw new Error(`Failed to process refund: ${errorText}`);
	}

	return response.json();
}
