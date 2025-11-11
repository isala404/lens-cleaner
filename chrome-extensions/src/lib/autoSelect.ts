/**
 * Auto-select functionality using backend API
 */

import db, { type Photo } from './db';
import { getJobStatus, startProcessing } from './api';

export interface AutoSelectState {
	isActive: boolean;
	jobId: string | null;
	status: 'idle' | 'uploading' | 'processing' | 'completed' | 'failed';
	uploadProgress: number;
	error: string | null;
	retryCount: number;
	maxRetries: number;
}

/**
 * Convert blob to File for upload
 */
function blobToFile(blob: Blob, filename: string): File {
	return new File([blob], filename, { type: blob.type });
}

/**
 * Prepare photos for upload (convert blobs to files)
 */
export async function preparePhotosForAutoSelect(photos: Photo[]): Promise<{
	files: File[];
	photoMetadata: Array<{ id: string; filename: string; group_id: string | null }>;
}> {
	const files: File[] = [];
	const photoMetadata: Array<{ id: string; filename: string; group_id: string | null }> = [];

	// Convert blobs to files
	for (const photo of photos) {
		const filename = `${photo.id}.jpg`;
		const file = blobToFile(photo.blob, filename);
		files.push(file);
		photoMetadata.push({
			id: photo.id,
			filename,
			group_id: photo.groupId
		});
	}

	return { files, photoMetadata };
}

/**
 * Poll for job completion with retry logic
 */
export async function pollJobStatus(
	jobId: string,
	onUpdate: (status: string) => void,
	onComplete: (results: {
		deletions: Array<{
			photo_id: string;
			reason: string;
			confidence: 'high' | 'medium' | 'low';
		}>;
	}) => void,
	onError: (error: string, canRetry: boolean) => void
): Promise<void> {
	const maxAttempts = 1000; // Max ~8 hours with 30s interval
	let attempts = 0;
	let consecutiveErrors = 0;
	const maxConsecutiveErrors = 3; // Allow 3 consecutive errors before showing retry option

	const poll = async () => {
		try {
			const response = await getJobStatus(jobId);
			consecutiveErrors = 0; // Reset error count on successful request

			// Always update status, even for failed jobs
			onUpdate(response.status);

			if (response.status === 'completed' && response.results) {
				onComplete(response.results);
			} else if (response.status === 'failed') {
				onError('Processing failed on the server', true);
			} else if (attempts < maxAttempts) {
				attempts++;
				setTimeout(poll, 30000); // Poll every 30 seconds
			} else {
				onError('Polling timeout - please check back later', true);
			}
		} catch (error) {
			console.error('Polling error:', error);
			consecutiveErrors++;
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

			if (consecutiveErrors >= maxConsecutiveErrors) {
				onError(`Connection failed: ${errorMessage}`, true);
			} else if (attempts < maxAttempts) {
				attempts++;
				setTimeout(poll, 30000); // Retry on error
			} else {
				onError(`Failed to get job status after multiple attempts: ${errorMessage}`, true);
			}
		}
	};

	poll();
}

/**
 * Retry a failed job by calling startProcessing again
 */
export async function retryJobStatus(
	jobId: string,
	photoMetadata: Array<{ id: string; filename: string; group_id: string | null }>,
	onUpdate: (status: string) => void,
	onComplete: (results: {
		deletions: Array<{
			photo_id: string;
			reason: string;
			confidence: 'high' | 'medium' | 'low';
		}>;
	}) => void,
	onError: (error: string, canRetry: boolean) => void
): Promise<void> {
	try {
		// Call startProcessing again to retry the job
		await startProcessing(jobId, photoMetadata);

		// Start polling for the retried job
		await pollJobStatus(jobId, onUpdate, onComplete, onError);
	} catch (error) {
		console.error('Retry error:', error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		onError(`Failed to retry job: ${errorMessage}`, true);
	}
}

/**
 * Apply AI suggestions to photos
 */
export async function applyAISuggestions(
	deletions: Array<{
		photo_id: string;
		reason: string;
		confidence: 'high' | 'medium' | 'low';
	}>
): Promise<void> {
	for (const deletion of deletions) {
		await db.updatePhotoAISuggestion(deletion.photo_id, deletion.reason, deletion.confidence);
	}
}
