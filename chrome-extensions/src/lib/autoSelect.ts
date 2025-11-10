/**
 * Auto-select functionality using backend API
 */

import db, { type Photo } from './db';
import { getJobStatus } from './api';

export interface AutoSelectState {
	isActive: boolean;
	jobId: string | null;
	status: 'idle' | 'uploading' | 'processing' | 'completed' | 'failed';
	uploadProgress: number;
	error: string | null;
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
 * Poll for job completion
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
	onError: (error: string) => void
): Promise<void> {
	const maxAttempts = 1000; // Max ~8 hours with 30s interval
	let attempts = 0;

	const poll = async () => {
		try {
			const response = await getJobStatus(jobId);
			onUpdate(response.status);

			if (response.status === 'completed' && response.results) {
				onComplete(response.results);
			} else if (response.status === 'failed') {
				onError('Processing failed');
			} else if (attempts < maxAttempts) {
				attempts++;
				setTimeout(poll, 30000); // Poll every 30 seconds
			} else {
				onError('Polling timeout - please check back later');
			}
		} catch (error) {
			console.error('Polling error:', error);
			if (attempts < maxAttempts) {
				attempts++;
				setTimeout(poll, 30000); // Retry on error
			} else {
				onError('Failed to get job status');
			}
		}
	};

	poll();
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
