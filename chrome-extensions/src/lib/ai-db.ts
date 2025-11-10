/**
 * IndexedDB storage for AI auto-select feature
 * Stores job information and AI processing results
 */

const AI_DB_NAME = 'LensCleanerAI';
const AI_DB_VERSION = 1;

export interface AIJob {
  id: string;
  paymentId: string;
  userId: string;
  status: 'created' | 'uploading' | 'uploaded' | 'processing' | 'completed' | 'failed';
  totalPhotos: number;
  uploadedPhotos: number;
  processedPhotos: number;
  progress: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AIResult {
  id: string;
  jobId: string;
  photoId: string;
  groupId: string;
  shouldDelete: boolean;
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
  createdAt: number;
}

class AIDatabase {
  private db: IDBDatabase | null = null;

  /**
   * Initialize the AI database
   */
  async init(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(AI_DB_NAME, AI_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // AI Jobs store
        if (!db.objectStoreNames.contains('ai_jobs')) {
          const jobsStore = db.createObjectStore('ai_jobs', { keyPath: 'id' });
          jobsStore.createIndex('status', 'status', { unique: false });
          jobsStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // AI Results store
        if (!db.objectStoreNames.contains('ai_results')) {
          const resultsStore = db.createObjectStore('ai_results', { keyPath: 'id' });
          resultsStore.createIndex('jobId', 'jobId', { unique: false });
          resultsStore.createIndex('photoId', 'photoId', { unique: false });
          resultsStore.createIndex('shouldDelete', 'shouldDelete', { unique: false });
        }
      };
    });
  }

  /**
   * Save AI job
   */
  async saveJob(job: AIJob): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_jobs'], 'readwrite');
    const store = transaction.objectStore('ai_jobs');

    return new Promise((resolve, reject) => {
      const request = store.put(job);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get AI job by ID
   */
  async getJob(jobId: string): Promise<AIJob | null> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_jobs'], 'readonly');
    const store = transaction.objectStore('ai_jobs');

    return new Promise((resolve, reject) => {
      const request = store.get(jobId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get latest AI job
   */
  async getLatestJob(): Promise<AIJob | null> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_jobs'], 'readonly');
    const store = transaction.objectStore('ai_jobs');
    const index = store.index('createdAt');

    return new Promise((resolve, reject) => {
      const request = index.openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? cursor.value : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all AI jobs
   */
  async getAllJobs(): Promise<AIJob[]> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_jobs'], 'readonly');
    const store = transaction.objectStore('ai_jobs');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: AIJob['status'],
    updates: Partial<AIJob> = {}
  ): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    job.status = status;
    job.updatedAt = Date.now();
    Object.assign(job, updates);

    if (status === 'completed') {
      job.completedAt = Date.now();
    }

    await this.saveJob(job);
  }

  /**
   * Save AI result
   */
  async saveResult(result: AIResult): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_results'], 'readwrite');
    const store = transaction.objectStore('ai_results');

    return new Promise((resolve, reject) => {
      const request = store.put(result);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Bulk save AI results
   */
  async saveResults(results: AIResult[]): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_results'], 'readwrite');
    const store = transaction.objectStore('ai_results');

    const promises = results.map(
      (result) =>
        new Promise<void>((resolve, reject) => {
          const request = store.put(result);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
  }

  /**
   * Get AI results for a job
   */
  async getResultsByJob(jobId: string): Promise<AIResult[]> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_results'], 'readonly');
    const store = transaction.objectStore('ai_results');
    const index = store.index('jobId');

    return new Promise((resolve, reject) => {
      const request = index.getAll(jobId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get AI result for a specific photo
   */
  async getResultByPhoto(photoId: string): Promise<AIResult | null> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_results'], 'readonly');
    const store = transaction.objectStore('ai_results');
    const index = store.index('photoId');

    return new Promise((resolve, reject) => {
      const request = index.get(photoId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get photos marked for deletion
   */
  async getPhotosMarkedForDeletion(jobId?: string): Promise<AIResult[]> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_results'], 'readonly');
    const store = transaction.objectStore('ai_results');
    const index = store.index('shouldDelete');

    return new Promise((resolve, reject) => {
      const request = index.getAll(true);
      request.onsuccess = () => {
        let results = request.result;
        if (jobId) {
          results = results.filter((r) => r.jobId === jobId);
        }
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear results for a job (useful for reprocessing)
   */
  async clearResultsByJob(jobId: string): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    const results = await this.getResultsByJob(jobId);
    const transaction = this.db.transaction(['ai_results'], 'readwrite');
    const store = transaction.objectStore('ai_results');

    const promises = results.map(
      (result) =>
        new Promise<void>((resolve, reject) => {
          const request = store.delete(result.id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
  }

  /**
   * Delete a job and its results
   */
  async deleteJob(jobId: string): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    // First clear results
    await this.clearResultsByJob(jobId);

    // Then delete job
    const transaction = this.db.transaction(['ai_jobs'], 'readwrite');
    const store = transaction.objectStore('ai_jobs');

    return new Promise((resolve, reject) => {
      const request = store.delete(jobId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all AI data
   */
  async clearAll(): Promise<void> {
    if (!this.db) throw new Error('AI Database not initialized');

    const transaction = this.db.transaction(['ai_jobs', 'ai_results'], 'readwrite');

    const promises = ['ai_jobs', 'ai_results'].map(
      (storeName) =>
        new Promise<void>((resolve, reject) => {
          const request = transaction.objectStore(storeName).clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        })
    );

    await Promise.all(promises);
  }
}

// Export singleton instance
const aiDB = new AIDatabase();
export default aiDB;
