/**
 * Photo grouping algorithm
 * Groups similar photos based on visual similarity and temporal proximity
 */

import { EmbeddingsProcessor } from './embeddings';
import type { Photo } from './db';

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

export class GroupingProcessor {
  private groups: PhotoGroup[] = [];

  /**
   * Group similar photos based on embeddings and time taken
   * @param photos - Array of photo objects with embeddings
   * @param embeddingMap - Map of photoId -> embedding array
   * @param similarityThreshold - Minimum similarity score (0-1)
   * @param timeWindowMinutes - Maximum time difference in minutes
   * @returns Array of groups
   */
  async groupSimilarPhotos(
    photos: Photo[],
    embeddingMap: Map<string, number[]>,
    similarityThreshold: number = 0.85,
    timeWindowMinutes: number = 60
  ): Promise<PhotoGroup[]> {
    console.log(`Grouping ${photos.length} photos...`);
    console.log(`Similarity threshold: ${similarityThreshold}`);
    console.log(`Time window: ${timeWindowMinutes} minutes`);

    // Sort photos by date taken
    const sortedPhotos = [...photos].sort((a, b) => {
      return new Date(a.dateTaken).getTime() - new Date(b.dateTaken).getTime();
    });

    const groups: PhotoGroup[] = [];
    const assignedPhotos = new Set<string>();

    // Use a sliding window approach
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

      const group: PhotoGroup = {
        photoIds: [photo1.id],
        similarities: [],
        avgSimilarity: 0,
        timeSpan: 0,
        startTime: new Date(photo1.dateTaken),
        endTime: new Date(photo1.dateTaken)
      };

      // Look ahead for similar photos within time window
      for (let j = i + 1; j < sortedPhotos.length; j++) {
        const photo2 = sortedPhotos[j];

        // Skip if already assigned
        if (assignedPhotos.has(photo2.id)) {
          continue;
        }

        // Check time window
        const timeDiff = this.getTimeDifferenceMinutes(
          photo1.dateTaken,
          photo2.dateTaken
        );

        if (timeDiff > timeWindowMinutes) {
          break; // Photos are sorted, so we can stop here
        }

        const embedding2 = embeddingMap.get(photo2.id);
        if (!embedding2) {
          continue;
        }

        // Calculate similarity
        const similarity = EmbeddingsProcessor.cosineSimilarity(
          embedding1,
          embedding2
        );

        // If similar enough, add to group
        if (similarity >= similarityThreshold) {
          group.photoIds.push(photo2.id);
          group.similarities.push(similarity);
          group.endTime = new Date(photo2.dateTaken);
        }
      }

      // Only create group if it has at least 2 photos
      if (group.photoIds.length >= 2) {
        // Calculate average similarity
        group.avgSimilarity =
          group.similarities.reduce((sum, s) => sum + s, 0) /
          group.similarities.length;

        // Calculate time span
        group.timeSpan =
          (group.endTime.getTime() - group.startTime.getTime()) / 1000 / 60; // in minutes

        // Mark all photos as assigned
        group.photoIds.forEach(id => assignedPhotos.add(id));

        groups.push(group);
      }
    }

    console.log(`Created ${groups.length} groups from ${photos.length} photos`);
    console.log(`Photos in groups: ${assignedPhotos.size}`);

    return groups;
  }

  /**
   * Get time difference in minutes between two dates
   */
  getTimeDifferenceMinutes(date1String: string, date2String: string): number {
    const d1 = new Date(date1String);
    const d2 = new Date(date2String);
    return Math.abs(d2.getTime() - d1.getTime()) / 1000 / 60;
  }

  /**
   * Advanced grouping using hierarchical clustering
   * Groups photos that are similar to each other transitively
   * (A similar to B, B similar to C => A, B, C in same group)
   */
  async hierarchicalGrouping(
    photos: Photo[],
    embeddingMap: Map<string, number[]>,
    similarityThreshold: number = 0.85,
    timeWindowMinutes: number = 60
  ): Promise<PhotoGroup[]> {
    console.log('Starting hierarchical clustering...');

    interface Cluster {
      photoIds: string[];
      centroid: number[];
      dateTaken: Date;
    }

    // Build similarity matrix for photos within time windows
    const clusters: Cluster[] = photos.map(photo => ({
      photoIds: [photo.id],
      centroid: embeddingMap.get(photo.id)!,
      dateTaken: new Date(photo.dateTaken)
    }));

    let merged = true;

    while (merged && clusters.length > 1) {
      merged = false;
      let maxSimilarity = -1;
      let mergeIndices: [number, number] = [-1, -1];

      // Find most similar pair within time window
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          // Check time window
          const timeDiff = Math.abs(
            clusters[i].dateTaken.getTime() - clusters[j].dateTaken.getTime()
          ) / 1000 / 60;

          if (timeDiff > timeWindowMinutes) {
            continue;
          }

          // Calculate similarity between centroids
          const similarity = EmbeddingsProcessor.cosineSimilarity(
            clusters[i].centroid,
            clusters[j].centroid
          );

          if (similarity > maxSimilarity && similarity >= similarityThreshold) {
            maxSimilarity = similarity;
            mergeIndices = [i, j];
            merged = true;
          }
        }
      }

      // Merge the most similar clusters
      if (merged) {
        const [i, j] = mergeIndices;
        const cluster1 = clusters[i];
        const cluster2 = clusters[j];

        // Merge photo IDs
        const mergedPhotoIds = [...cluster1.photoIds, ...cluster2.photoIds];

        // Calculate new centroid (average of embeddings)
        const newCentroid = this.averageEmbeddings([
          cluster1.centroid,
          cluster2.centroid
        ]);

        // Use earlier date as cluster date
        const newDate =
          cluster1.dateTaken < cluster2.dateTaken
            ? cluster1.dateTaken
            : cluster2.dateTaken;

        // Create merged cluster
        const mergedCluster: Cluster = {
          photoIds: mergedPhotoIds,
          centroid: newCentroid,
          dateTaken: newDate
        };

        // Remove old clusters and add new one
        clusters.splice(Math.max(i, j), 1);
        clusters.splice(Math.min(i, j), 1);
        clusters.push(mergedCluster);
      }
    }

    // Convert clusters to groups format
    const groups: PhotoGroup[] = clusters
      .filter(cluster => cluster.photoIds.length >= 2)
      .map(cluster => ({
        photoIds: cluster.photoIds,
        similarities: [],
        avgSimilarity: 0.9, // Approximate since we don't track individual similarities
        timeSpan: 0,
        startTime: cluster.dateTaken,
        endTime: cluster.dateTaken
      }));

    console.log(`Hierarchical clustering created ${groups.length} groups`);

    return groups;
  }

  /**
   * Calculate average of multiple embeddings
   */
  averageEmbeddings(embeddings: number[][]): number[] {
    const length = embeddings[0].length;
    const avg = new Array(length).fill(0);

    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const embedding of embeddings) {
        sum += embedding[i];
      }
      avg[i] = sum / embeddings.length;
    }

    // Normalize the average
    const norm = Math.sqrt(
      avg.reduce((sum, val) => sum + val * val, 0)
    );

    if (norm > 0) {
      for (let i = 0; i < length; i++) {
        avg[i] /= norm;
      }
    }

    return avg;
  }

  /**
   * Find duplicate photos (very high similarity, e.g., > 0.95)
   */
  async findDuplicates(
    photos: Photo[],
    embeddingMap: Map<string, number[]>,
    duplicateThreshold: number = 0.95
  ): Promise<PhotoGroup[]> {
    console.log('Finding exact duplicates...');

    const duplicates: PhotoGroup[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < photos.length; i++) {
      const photo1 = photos[i];

      if (processed.has(photo1.id)) {
        continue;
      }

      const embedding1 = embeddingMap.get(photo1.id);
      if (!embedding1) {
        continue;
      }

      const duplicateGroup: string[] = [photo1.id];

      for (let j = i + 1; j < photos.length; j++) {
        const photo2 = photos[j];

        if (processed.has(photo2.id)) {
          continue;
        }

        const embedding2 = embeddingMap.get(photo2.id);
        if (!embedding2) {
          continue;
        }

        const similarity = EmbeddingsProcessor.cosineSimilarity(
          embedding1,
          embedding2
        );

        if (similarity >= duplicateThreshold) {
          duplicateGroup.push(photo2.id);
          processed.add(photo2.id);
        }
      }

      if (duplicateGroup.length >= 2) {
        duplicates.push({
          photoIds: duplicateGroup,
          similarities: [],
          avgSimilarity: duplicateThreshold,
          timeSpan: 0,
          startTime: new Date(photo1.dateTaken),
          endTime: new Date(photo1.dateTaken)
        });
        processed.add(photo1.id);
      }
    }

    console.log(`Found ${duplicates.length} duplicate groups`);

    return duplicates;
  }

  /**
   * Get statistics about grouping results
   */
  getGroupingStats(groups: PhotoGroup[]): GroupingStats {
    const totalPhotosInGroups = groups.reduce(
      (sum, group) => sum + group.photoIds.length,
      0
    );

    const avgGroupSize =
      groups.length > 0 ? totalPhotosInGroups / groups.length : 0;

    const avgSimilarity =
      groups.length > 0
        ? groups.reduce((sum, g) => sum + g.avgSimilarity, 0) / groups.length
        : 0;

    const groupSizes = groups.map(g => g.photoIds.length);
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
}

export default GroupingProcessor;
