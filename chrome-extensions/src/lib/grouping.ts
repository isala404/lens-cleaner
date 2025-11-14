/**
 * Photo grouping algorithm - Memory Efficient Sliding Window Version
 * Groups similar photos based on visual similarity using overlapping time windows
 * Only loads a small window of data at a time to minimize memory usage
 */

import type { Photo, Embedding } from './db';

export interface PhotoGroup {
	photoIds: string[];
	similarities: number[];
	avgSimilarity: number;
	timeSpan: number;
	startTime: Date;
	endTime: Date;
}

export interface GroupingStats {
	totalGroups: number;
	totalPhotosInGroups: number;
	avgGroupSize: string;
	avgSimilarity: string;
	maxGroupSize: number;
	minGroupSize: number;
}

export interface GroupingProgress {
	photosProcessed: number;
	totalPhotos: number;
	groupsFound: number;
	currentWindow: number;
	totalWindows: number;
}

/**
 * Cosine similarity between two embedding vectors
 */
function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
	if (embedding1.length !== embedding2.length) {
		throw new Error('Embedding dimensions must match');
	}

	let dotProduct = 0;
	let norm1 = 0;
	let norm2 = 0;

	for (let i = 0; i < embedding1.length; i++) {
		dotProduct += embedding1[i] * embedding2[i];
		norm1 += embedding1[i] * embedding1[i];
		norm2 += embedding2[i] * embedding2[i];
	}

	norm1 = Math.sqrt(norm1);
	norm2 = Math.sqrt(norm2);

	if (norm1 === 0 || norm2 === 0) {
		return 0;
	}

	return dotProduct / (norm1 * norm2);
}

/**
 * Cluster photos within a single time window
 */
function clusterWindow(
	photos: Photo[],
	embeddings: Embedding[],
	similarityThreshold: number,
	timeWindowMinutes: number
): PhotoGroup[] {
	// Create embedding map for quick lookup
	const embeddingMap = new Map<string, number[]>();
	embeddings.forEach((emb) => {
		embeddingMap.set(emb.photoId, emb.embedding);
	});

	// Sort photos by timestamp (oldest first)
	const sortedPhotos = [...photos].sort((a, b) => a.timestamp - b.timestamp);
	const groups: PhotoGroup[] = [];
	const assignedPhotos = new Set<string>();
	const timeWindowSeconds = timeWindowMinutes * 60;

	// Group photos using sliding window within this time window
	for (let i = 0; i < sortedPhotos.length; i++) {
		const photo1 = sortedPhotos[i];

		// Skip if already assigned to a group
		if (assignedPhotos.has(photo1.id)) {
			continue;
		}

		const embedding1 = embeddingMap.get(photo1.id);
		if (!embedding1) {
			continue;
		}

		// Mark photo1 as processed immediately
		assignedPhotos.add(photo1.id);

		// Start a new group with photo1
		const group: PhotoGroup = {
			photoIds: [photo1.id],
			similarities: [],
			avgSimilarity: 0,
			timeSpan: 0,
			startTime: new Date(photo1.dateTaken),
			endTime: new Date(photo1.dateTaken)
		};

		// Store embeddings of photos in this group for comparison
		const groupEmbeddings: Array<{ id: string; embedding: number[] }> = [
			{ id: photo1.id, embedding: embedding1 }
		];

		const photo1Time = photo1.timestamp;

		// Look ahead for similar photos within time window
		for (let j = i + 1; j < sortedPhotos.length; j++) {
			const photo2 = sortedPhotos[j];

			// Skip if already assigned
			if (assignedPhotos.has(photo2.id)) {
				continue;
			}

			const photo2Time = photo2.timestamp;

			// Check time window
			const timeDiffSeconds = Math.abs(photo2Time - photo1Time) / 1000;

			// Break early if we've gone past the time window (photos are sorted)
			if (photo2Time > photo1Time && timeDiffSeconds > timeWindowSeconds) {
				break;
			}

			// Skip if outside time window but continue checking
			if (timeDiffSeconds > timeWindowSeconds) {
				continue;
			}

			const embedding2 = embeddingMap.get(photo2.id);
			if (!embedding2) {
				continue;
			}

			// Check similarity against ALL photos in the group
			let maxSimilarity = -1;
			let isSimilarToGroup = false;

			for (const groupPhoto of groupEmbeddings) {
				const similarity = cosineSimilarity(groupPhoto.embedding, embedding2);
				maxSimilarity = Math.max(maxSimilarity, similarity);

				// If similar enough to any photo in the group, add it
				if (similarity >= similarityThreshold) {
					isSimilarToGroup = true;
					break;
				}
			}

			// If similar enough to the group, add to group and mark as processed
			if (isSimilarToGroup) {
				group.photoIds.push(photo2.id);
				group.similarities.push(maxSimilarity);
				group.endTime = new Date(photo2.dateTaken);
				assignedPhotos.add(photo2.id);

				// Add this photo's embedding to the group for future comparisons
				groupEmbeddings.push({ id: photo2.id, embedding: embedding2 });
			}
		}

		// Only create group if it has at least 2 photos
		if (group.photoIds.length >= 2) {
			// Calculate average similarity
			group.avgSimilarity =
				group.similarities.reduce((sum, s) => sum + s, 0) / group.similarities.length;

			// Calculate time span
			group.timeSpan = (group.endTime.getTime() - group.startTime.getTime()) / 1000 / 60; // in minutes

			groups.push(group);
		}
	}

	return groups;
}

/**
 * Remove photos that have already been processed from a window
 */
function deduplicateWindow(
	photos: Photo[],
	embeddings: Embedding[],
	processedPhotoIds: Set<string>
): { photos: Photo[]; embeddings: Embedding[] } {
	const photoSet = new Set(photos.map((p) => p.id));
	const remainingPhotoIds = new Set([...photoSet].filter((id) => !processedPhotoIds.has(id)));

	const remainingPhotos = photos.filter((p) => remainingPhotoIds.has(p.id));
	const remainingEmbeddings = embeddings.filter((e) => remainingPhotoIds.has(e.photoId));

	return { photos: remainingPhotos, embeddings: remainingEmbeddings };
}

/**
 * Memory-efficient clustering using overlapping sliding windows
 * Only loads a small window of data at a time to minimize memory usage
 *
 * @param similarityThreshold - Minimum similarity score (0-1)
 * @param windowSizeMinutes - Size of each time window in minutes
 * @param overlapMinutes - Overlap between consecutive windows in minutes
 * @param timeWindowMinutes - Maximum time difference for grouping within a window
 * @param onProgress - Optional progress callback
 * @param db - Database instance for streaming data
 */
export async function clusterImagesWithOverlap(
	similarityThreshold: number = 0.6,
	windowSizeMinutes: number = 60,
	overlapMinutes: number = 30,
	timeWindowMinutes: number = 60,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: any, // Database instance - required parameter
	onProgress?: (progress: GroupingProgress) => void
): Promise<PhotoGroup[]> {
	console.log(`Starting memory-efficient clustering with sliding windows...`);
	console.log(`Window size: ${windowSizeMinutes} minutes, Overlap: ${overlapMinutes} minutes`);
	console.log(
		`Similarity threshold: ${similarityThreshold}, Time window: ${timeWindowMinutes} minutes`
	);

	// Cast database to any for method calls
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const dbInstance = db as any;

	// Ensure database is initialized
	if (!dbInstance.db) {
		await dbInstance.init();
	}

	// Get the overall time range of all photos
	const { minTime, maxTime } = await dbInstance.getPhotoTimeRange();

	// Get total photo count for accurate progress tracking
	const allPhotos = await dbInstance.getAllPhotos();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const totalPhotoCount = allPhotos.filter((p: any) => p.hasEmbedding).length;

	if (totalPhotoCount === 0) {
		console.warn('No photos have embeddings! Cannot create groups.');
		return [];
	}
	const totalDurationMs = maxTime - minTime;
	const windowSizeMs = windowSizeMinutes * 60 * 1000;
	const overlapMs = overlapMinutes * 60 * 1000;
	const stepMs = windowSizeMs - overlapMs;

	const totalWindows = Math.ceil(totalDurationMs / stepMs);
	const allGroups: PhotoGroup[] = [];
	const processedPhotoIds = new Set<string>();

	let totalPhotosProcessed = 0;

	// Process each overlapping window
	for (let windowIndex = 0; windowIndex < totalWindows; windowIndex++) {
		const windowStartMs = minTime + windowIndex * stepMs;
		const windowEndMs = Math.min(windowStartMs + windowSizeMs, maxTime);

		console.log(
			`Processing window ${windowIndex + 1}/${totalWindows}: ${new Date(windowStartMs).toISOString()} to ${new Date(windowEndMs).toISOString()}`
		);

		// Stream photos for this window
		const windowPhotos = await dbInstance.getPhotosWithEmbeddingsInTimeRange(
			windowStartMs,
			windowEndMs
		);

		// Get embeddings for these photos
		const photoIds = windowPhotos.map((p: Photo) => p.id);
		const windowEmbeddings = await dbInstance.getEmbeddingsForPhotos(photoIds);

		// Remove already processed photos
		const { photos, embeddings } = deduplicateWindow(
			windowPhotos,
			windowEmbeddings,
			processedPhotoIds
		);

		if (photos.length === 0) {
			console.log(`Window ${windowIndex + 1}: No new photos to process`);
			continue;
		}

		// Cluster photos within this window
		const windowGroups = clusterWindow(photos, embeddings, similarityThreshold, timeWindowMinutes);

		// Add groups to results
		allGroups.push(...windowGroups);

		// Mark all photos in this window as processed
		photos.forEach((photo) => processedPhotoIds.add(photo.id));
		totalPhotosProcessed += photos.length;

		// Report progress
		if (onProgress) {
			onProgress({
				photosProcessed: totalPhotosProcessed,
				totalPhotos: totalPhotoCount, // Use actual total for accurate progress bar
				groupsFound: allGroups.length,
				currentWindow: windowIndex + 1,
				totalWindows: totalWindows
			});
		}

		// Small delay to prevent UI blocking
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	console.log(
		`Clustering complete: ${allGroups.length} groups from ${totalPhotosProcessed} photos`
	);

	return allGroups;
}

/**
 * Get statistics about grouping results
 */
export function getGroupingStats(groups: PhotoGroup[]): GroupingStats {
	const totalPhotosInGroups = groups.reduce((sum, group) => sum + group.photoIds.length, 0);

	const avgGroupSize = groups.length > 0 ? totalPhotosInGroups / groups.length : 0;

	const avgSimilarity =
		groups.length > 0 ? groups.reduce((sum, g) => sum + g.avgSimilarity, 0) / groups.length : 0;

	const groupSizes = groups.map((g) => g.photoIds.length);
	const maxGroupSize = Math.max(...groupSizes, 0);
	const minGroupSize = Math.min(...groupSizes, Infinity);

	return {
		totalGroups: groups.length,
		totalPhotosInGroups,
		avgGroupSize: avgGroupSize.toFixed(2),
		avgSimilarity: avgSimilarity.toFixed(3),
		maxGroupSize,
		minGroupSize: minGroupSize === Infinity ? 0 : minGroupSize
	};
}

// Legacy exports for backward compatibility
export class GroupingProcessor {
	/**
	 * Legacy method - redirects to new sliding window implementation
	 */
	async groupSimilarPhotosBatched(
		photos: Photo[],
		embeddingMap: Map<string, number[]>,
		similarityThreshold: number = 0.6,
		timeWindowMinutes: number = 60,
		onProgress?: (progress: GroupingProgress) => void
	): Promise<PhotoGroup[]> {
		console.warn(
			'Using legacy GroupingProcessor - consider migrating to clusterImagesWithOverlap for better memory efficiency'
		);

		// For legacy support, we'll use the old algorithm but this is not memory efficient
		// In practice, this should be replaced with clusterImagesWithOverlap
		const db = (await import('./db')).default;

		// Use a small window size to simulate batching
		return clusterImagesWithOverlap(
			similarityThreshold,
			30, // 30 minute windows
			15, // 15 minute overlap
			timeWindowMinutes,
			db,
			onProgress
		);
	}

	/**
	 * Get statistics about grouping results
	 */
	getGroupingStats(groups: PhotoGroup[]): GroupingStats {
		return getGroupingStats(groups);
	}
}

export default GroupingProcessor;
