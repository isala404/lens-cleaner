/**
 * Photo Upload Manager with parallel uploads, retry logic, and resume support
 */

import { apiClient } from './api-client';

export interface UploadProgress {
  total: number;
  uploaded: number;
  failed: number;
  inProgress: number;
  percentage: number;
}

export interface UploadResult {
  photoId: string;
  success: boolean;
  error?: string;
  retries: number;
}

const DEFAULT_CONCURRENCY = 20;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000; // ms

export class UploadManager {
  private jobId: string;
  private photos: Map<string, Blob>;
  private concurrency: number;
  private maxRetries: number;
  private retryDelay: number;

  private uploadedPhotos: Set<string> = new Set();
  private failedPhotos: Map<string, number> = new Map(); // photoId -> retry count
  private inProgressPhotos: Set<string> = new Set();

  private onProgress?: (progress: UploadProgress) => void;
  private aborted = false;

  constructor(
    jobId: string,
    photos: Map<string, Blob>,
    options: {
      concurrency?: number;
      maxRetries?: number;
      retryDelay?: number;
      onProgress?: (progress: UploadProgress) => void;
    } = {}
  ) {
    this.jobId = jobId;
    this.photos = photos;
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.retryDelay = options.retryDelay || DEFAULT_RETRY_DELAY;
    this.onProgress = options.onProgress;
  }

  /**
   * Load previously uploaded photos from localStorage for resume support
   */
  private loadUploadedPhotos(): void {
    const key = `upload_progress_${this.jobId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this.uploadedPhotos = new Set(data.uploaded || []);
        console.log(`Resuming upload: ${this.uploadedPhotos.size} photos already uploaded`);
      } catch (e) {
        console.error('Failed to load upload progress:', e);
      }
    }
  }

  /**
   * Save upload progress to localStorage
   */
  private saveUploadProgress(): void {
    const key = `upload_progress_${this.jobId}`;
    const data = {
      uploaded: Array.from(this.uploadedPhotos),
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(data));
  }

  /**
   * Clear upload progress from localStorage
   */
  private clearUploadProgress(): void {
    const key = `upload_progress_${this.jobId}`;
    localStorage.removeItem(key);
  }

  /**
   * Get current upload progress
   */
  private getProgress(): UploadProgress {
    const total = this.photos.size;
    const uploaded = this.uploadedPhotos.size;
    const failed = this.failedPhotos.size;
    const inProgress = this.inProgressPhotos.size;
    const percentage = total > 0 ? (uploaded / total) * 100 : 0;

    return { total, uploaded, failed, inProgress, percentage };
  }

  /**
   * Notify progress callback
   */
  private notifyProgress(): void {
    if (this.onProgress) {
      this.onProgress(this.getProgress());
    }
  }

  /**
   * Upload a single photo with retry logic
   */
  private async uploadPhoto(photoId: string, blob: Blob): Promise<UploadResult> {
    const retries = this.failedPhotos.get(photoId) || 0;

    // Check if already uploaded (for resume support)
    if (this.uploadedPhotos.has(photoId)) {
      return { photoId, success: true, retries };
    }

    // Check if max retries exceeded
    if (retries >= this.maxRetries) {
      return {
        photoId,
        success: false,
        error: `Max retries (${this.maxRetries}) exceeded`,
        retries,
      };
    }

    this.inProgressPhotos.add(photoId);
    this.notifyProgress();

    try {
      await apiClient.uploadPhoto(this.jobId, photoId, blob);

      this.uploadedPhotos.add(photoId);
      this.failedPhotos.delete(photoId);
      this.inProgressPhotos.delete(photoId);

      this.saveUploadProgress();
      this.notifyProgress();

      return { photoId, success: true, retries };
    } catch (error) {
      this.inProgressPhotos.delete(photoId);
      const newRetries = retries + 1;
      this.failedPhotos.set(photoId, newRetries);

      this.notifyProgress();

      // Retry with exponential backoff
      if (newRetries < this.maxRetries && !this.aborted) {
        const delay = this.retryDelay * Math.pow(2, retries);
        console.log(`Retrying ${photoId} in ${delay}ms (attempt ${newRetries + 1}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.uploadPhoto(photoId, blob);
      }

      return {
        photoId,
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed',
        retries: newRetries,
      };
    }
  }

  /**
   * Start uploading all photos with parallel processing
   */
  async uploadAll(): Promise<UploadResult[]> {
    this.aborted = false;
    this.loadUploadedPhotos();
    this.notifyProgress();

    const photoEntries = Array.from(this.photos.entries());
    const results: UploadResult[] = [];

    // Process photos in batches
    for (let i = 0; i < photoEntries.length; i += this.concurrency) {
      if (this.aborted) {
        console.log('Upload aborted');
        break;
      }

      const batch = photoEntries.slice(i, i + this.concurrency);
      const batchPromises = batch.map(([photoId, blob]) =>
        this.uploadPhoto(photoId, blob)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    // Clear progress if all successful
    const allSuccessful = results.every(r => r.success);
    if (allSuccessful) {
      this.clearUploadProgress();
    }

    return results;
  }

  /**
   * Retry failed uploads
   */
  async retryFailed(): Promise<UploadResult[]> {
    const failedPhotoIds = Array.from(this.failedPhotos.keys());
    const results: UploadResult[] = [];

    for (const photoId of failedPhotoIds) {
      if (this.aborted) break;

      const blob = this.photos.get(photoId);
      if (!blob) continue;

      const result = await this.uploadPhoto(photoId, blob);
      results.push(result);
    }

    return results;
  }

  /**
   * Abort ongoing uploads
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Get failed photo IDs
   */
  getFailedPhotos(): string[] {
    return Array.from(this.failedPhotos.keys());
  }

  /**
   * Get successfully uploaded photo IDs
   */
  getUploadedPhotos(): string[] {
    return Array.from(this.uploadedPhotos);
  }
}
