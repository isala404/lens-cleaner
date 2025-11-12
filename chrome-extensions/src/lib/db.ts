/**
 * IndexedDB wrapper for Lens Cleaner - STREAMING & BATCHED VERSION
 * Optimized for handling 1M+ photos without memory crashes
 *
 * Key improvements:
 * - Cursor-based batching instead of getAll()
 * - localStorage metadata caching for instant stats
 * - Compound indexes for efficient queries
 * - Streaming operations with constant memory usage
 */

const DB_NAME = 'LensCleanerDB';
const DB_VERSION = 1; // Fresh start with optimized schema

// ===== INTERFACES =====

export interface Photo {
	id: string;
	blob: Blob;
	mediaType: string;
	dateTaken: string;
	fileName?: string;
	timestamp: number;
	hasEmbedding: boolean;
	groupId: string | null;
	aiSuggestionReason?: string;
	aiSuggestionConfidence?: 'high' | 'medium' | 'low';
	googlePhotosUrl?: string;
}

export interface Embedding {
	photoId: string;
	embedding: number[];
	timestamp: number;
}

export interface Group {
	id: string;
	photoIds: string[];
	similarityScore: number;
	timestamp: number;
	reviewStatus: 'pending' | 'reviewed' | 'deleted';
}

export interface Stats {
	totalPhotos: number;
	photosWithEmbeddings: number;
	totalGroups: number;
	photosInGroups: number;
	ungroupedWithEmbeddings: number;
	selectedPhotos: number;
	lastScrapeTime?: number;
	lastEmbeddingTime?: number;
	lastGroupingTime?: number;
	lastUpdated: number;
}

// ===== METADATA CACHE =====

/**
 * localStorage-based metadata cache for instant UI rendering
 * Eliminates need to query IndexedDB for counts/stats
 */
class MetadataCache {
	private readonly STATS_KEY = 'lens_stats_cache_v2';
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	// Check if localStorage is available (not available in service workers)
	private get hasLocalStorage(): boolean {
		try {
			return typeof localStorage !== 'undefined' && localStorage !== null;
		} catch {
			return false;
		}
	}

	getCachedStats(): Stats | null {
		if (!this.hasLocalStorage) return null;

		try {
			const cached = localStorage.getItem(this.STATS_KEY);
			if (!cached) return null;

			const stats = JSON.parse(cached) as Stats;

			// Cache valid for TTL
			if (Date.now() - stats.lastUpdated > this.CACHE_TTL) {
				return null;
			}

			return stats;
		} catch {
			return null;
		}
	}

	updateStats(stats: Stats): void {
		if (!this.hasLocalStorage) return;

		try {
			localStorage.setItem(this.STATS_KEY, JSON.stringify({
				...stats,
				lastUpdated: Date.now()
			}));
		} catch (error) {
			console.warn('Failed to cache stats:', error);
		}
	}

	incrementPhotoCount(delta: number = 1): void {
		if (!this.hasLocalStorage) return;

		const stats = this.getCachedStats();
		if (stats) {
			stats.totalPhotos += delta;
			stats.lastUpdated = Date.now();
			this.updateStats(stats);
		}
	}

	incrementEmbeddingCount(delta: number = 1): void {
		if (!this.hasLocalStorage) return;

		const stats = this.getCachedStats();
		if (stats) {
			stats.photosWithEmbeddings += delta;
			stats.lastUpdated = Date.now();
			this.updateStats(stats);
		}
	}

	incrementGroupCount(delta: number = 1): void {
		if (!this.hasLocalStorage) return;

		const stats = this.getCachedStats();
		if (stats) {
			stats.totalGroups += delta;
			stats.lastUpdated = Date.now();
			this.updateStats(stats);
		}
	}

	invalidate(): void {
		if (!this.hasLocalStorage) return;

		try {
			localStorage.removeItem(this.STATS_KEY);
		} catch (error) {
			console.warn('Failed to invalidate cache:', error);
		}
	}
}

// ===== MAIN DATABASE CLASS =====

class LensDB {
	private db: IDBDatabase | null = null;
	private cache = new MetadataCache();

	/**
	 * Initialize the database with optimized schema
	 */
	async init(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve(this.db);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Photos store with compound indexes
				if (!db.objectStoreNames.contains('photos')) {
					const photosStore = db.createObjectStore('photos', { keyPath: 'id' });
					photosStore.createIndex('timestamp', 'timestamp', { unique: false });
					photosStore.createIndex('dateTaken', 'dateTaken', { unique: false });
					photosStore.createIndex('hasEmbedding', 'hasEmbedding', { unique: false });
					photosStore.createIndex('groupId', 'groupId', { unique: false });

					// Compound indexes for efficient queries
					photosStore.createIndex('embeddingAndGroup', ['hasEmbedding', 'groupId'], { unique: false });
					photosStore.createIndex('timestampAndEmbedding', ['timestamp', 'hasEmbedding'], { unique: false });
				}

				// Embeddings store
				if (!db.objectStoreNames.contains('embeddings')) {
					const embStore = db.createObjectStore('embeddings', { keyPath: 'photoId' });
					embStore.createIndex('timestamp', 'timestamp', { unique: false });
				}

				// Groups store
				if (!db.objectStoreNames.contains('groups')) {
					const groupsStore = db.createObjectStore('groups', { keyPath: 'id' });
					groupsStore.createIndex('timestamp', 'timestamp', { unique: false });
					groupsStore.createIndex('reviewStatus', 'reviewStatus', { unique: false });
				}

				// Metadata store
				if (!db.objectStoreNames.contains('metadata')) {
					db.createObjectStore('metadata', { keyPath: 'key' });
				}

				// Auto-select jobs store
				if (!db.objectStoreNames.contains('autoSelectJobs')) {
					const jobsStore = db.createObjectStore('autoSelectJobs', { keyPath: 'jobId' });
					jobsStore.createIndex('createdAt', 'createdAt', { unique: false });
					jobsStore.createIndex('status', 'status', { unique: false });
				}

				// Selection state store
				if (!db.objectStoreNames.contains('selectedPhotos')) {
					const selectedStore = db.createObjectStore('selectedPhotos', { keyPath: 'photoId' });
					selectedStore.createIndex('selectedAt', 'selectedAt', { unique: false });
				}

				// After schema changes, invalidate cache
				this.cache.invalidate();
			};
		});
	}

	// ===== BATCHED READ METHODS (Primary Interface) =====

	/**
	 * Get photos in batches using cursor-based pagination
	 * This is the PRIMARY method for reading photos - never loads all into memory
	 *
	 * @param offset - Number of records to skip
	 * @param limit - Maximum number of records to return
	 * @param direction - Sort direction ('newest' or 'oldest')
	 * @returns Array of photos (max size = limit)
	 */
	async getPhotosBatch(
		offset: number = 0,
		limit: number = 100,
		direction: 'newest' | 'oldest' = 'newest'
	): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const photos: Photo[] = [];
			let skipped = 0;
			const cursorDirection = direction === 'newest' ? 'prev' : 'next';
			const request = store.index('timestamp').openCursor(null, cursorDirection);

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (skipped < offset) {
						skipped++;
						cursor.continue();
					} else if (photos.length < limit) {
						photos.push(cursor.value);
						cursor.continue();
					} else {
						resolve(photos);
					}
				} else {
					resolve(photos);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get embeddings in batches
	 */
	async getEmbeddingsBatch(offset: number = 0, limit: number = 1000): Promise<Embedding[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings'], 'readonly');
		const store = transaction.objectStore('embeddings');

		return new Promise((resolve, reject) => {
			const embeddings: Embedding[] = [];
			let skipped = 0;
			const request = store.openCursor();

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (skipped < offset) {
						skipped++;
						cursor.continue();
					} else if (embeddings.length < limit) {
						embeddings.push(cursor.value);
						cursor.continue();
					} else {
						resolve(embeddings);
					}
				} else {
					resolve(embeddings);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get groups in batches
	 */
	async getGroupsBatch(offset: number = 0, limit: number = 500): Promise<Group[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readonly');
		const store = transaction.objectStore('groups');

		return new Promise((resolve, reject) => {
			const groups: Group[] = [];
			let skipped = 0;
			const request = store.index('timestamp').openCursor(null, 'prev');

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (skipped < offset) {
						skipped++;
						cursor.continue();
					} else if (groups.length < limit) {
						groups.push(cursor.value);
						cursor.continue();
					} else {
						resolve(groups);
					}
				} else {
					resolve(groups);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get photos without embeddings (for processing queue)
	 * Uses index for efficient filtering
	 */
	async getPhotosWithoutEmbeddings(limit: number = Infinity): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const results: Photo[] = [];
			const index = store.index('hasEmbedding');
			const range = IDBKeyRange.only(false);
			const request = index.openCursor(range);

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor && results.length < limit) {
					results.push(cursor.value);
					cursor.continue();
				} else {
					resolve(results);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get ungrouped photos with embeddings
	 * Uses compound index for O(log n) query
	 */
	async getUngroupedPhotosBatch(offset: number = 0, limit: number = 100): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const photos: Photo[] = [];
			let skipped = 0;

			// Query compound index: hasEmbedding=true AND groupId=null
			const range = IDBKeyRange.only([true, null]);
			const request = store.index('embeddingAndGroup').openCursor(range);

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (skipped < offset) {
						skipped++;
						cursor.continue();
					} else if (photos.length < limit) {
						photos.push(cursor.value);
						cursor.continue();
					} else {
						resolve(photos);
					}
				} else {
					resolve(photos);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Iterate through all photos in batches with a callback
	 * Prevents loading all photos into memory at once
	 */
	async forEachPhotoBatch(
		callback: (batch: Photo[], batchIndex: number) => Promise<void>,
		batchSize: number = 100
	): Promise<void> {
		let offset = 0;
		let batchIndex = 0;

		while (true) {
			const batch = await this.getPhotosBatch(offset, batchSize);
			if (batch.length === 0) break;

			await callback(batch, batchIndex);
			offset += batch.length;
			batchIndex++;

			if (batch.length < batchSize) break;
		}
	}

	/**
	 * Iterate through all embeddings in batches
	 */
	async forEachEmbeddingBatch(
		callback: (batch: Embedding[], batchIndex: number) => Promise<void>,
		batchSize: number = 1000
	): Promise<void> {
		let offset = 0;
		let batchIndex = 0;

		while (true) {
			const batch = await this.getEmbeddingsBatch(offset, batchSize);
			if (batch.length === 0) break;

			await callback(batch, batchIndex);
			offset += batch.length;
			batchIndex++;

			if (batch.length < batchSize) break;
		}
	}

	/**
	 * Iterate through all groups in batches
	 */
	async forEachGroupBatch(
		callback: (batch: Group[], batchIndex: number) => Promise<void>,
		batchSize: number = 500
	): Promise<void> {
		let offset = 0;
		let batchIndex = 0;

		while (true) {
			const batch = await this.getGroupsBatch(offset, batchSize);
			if (batch.length === 0) break;

			await callback(batch, batchIndex);
			offset += batch.length;
			batchIndex++;

			if (batch.length < batchSize) break;
		}
	}

	// ===== EFFICIENT COUNT METHODS =====

	/**
	 * Get total photo count (O(1) operation using IndexedDB count)
	 */
	async getPhotoCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const request = store.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get embedding count
	 */
	async getEmbeddingCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings'], 'readonly');
		const store = transaction.objectStore('embeddings');

		return new Promise((resolve, reject) => {
			const request = store.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get group count
	 */
	async getGroupCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readonly');
		const store = transaction.objectStore('groups');

		return new Promise((resolve, reject) => {
			const request = store.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get count of photos with embeddings
	 */
	async getPhotosWithEmbeddingCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const range = IDBKeyRange.only(true);
			const request = store.index('hasEmbedding').count(range);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get count of photos in groups
	 */
	async getPhotosInGroupsCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		// Count photos where groupId is NOT null
		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			let count = 0;
			const request = store.openCursor();

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (cursor.value.groupId !== null) {
						count++;
					}
					cursor.continue();
				} else {
					resolve(count);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get count of ungrouped photos with embeddings
	 * Uses compound index for efficiency
	 */
	async getUngroupedPhotoCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const range = IDBKeyRange.only([true, null]);
			const request = store.index('embeddingAndGroup').count(range);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	// ===== STATS WITH CACHING =====

	/**
	 * Get statistics with localStorage caching
	 * Returns cached stats immediately, refreshes in background
	 */
	async getStats(): Promise<Stats> {
		// Try cache first
		const cached = this.cache.getCachedStats();
		if (cached) {
			// Refresh in background (non-blocking)
			this.refreshStatsBackground();
			return cached;
		}

		// No cache, calculate fresh
		return await this.refreshStats();
	}

	/**
	 * Calculate fresh stats and update cache
	 */
	async refreshStats(): Promise<Stats> {
		const [
			totalPhotos,
			photosWithEmbeddings,
			totalGroups,
			photosInGroups,
			ungroupedWithEmbeddings,
			selectedPhotos
		] = await Promise.all([
			this.getPhotoCount(),
			this.getPhotosWithEmbeddingCount(),
			this.getGroupCount(),
			this.getPhotosInGroupsCount(),
			this.getUngroupedPhotoCount(),
			this.getSelectedPhotosCount()
		]);

		const lastScrapeTime = (await this.getMetadata('lastScrapeTime')) as number | undefined;
		const lastEmbeddingTime = (await this.getMetadata('lastEmbeddingTime')) as number | undefined;
		const lastGroupingTime = (await this.getMetadata('lastGroupingTime')) as number | undefined;

		const stats: Stats = {
			totalPhotos,
			photosWithEmbeddings,
			totalGroups,
			photosInGroups,
			ungroupedWithEmbeddings,
			selectedPhotos,
			lastScrapeTime,
			lastEmbeddingTime,
			lastGroupingTime,
			lastUpdated: Date.now()
		};

		this.cache.updateStats(stats);
		return stats;
	}

	/**
	 * Refresh stats in background (non-blocking)
	 */
	private refreshStatsBackground(): void {
		setTimeout(async () => {
			try {
				await this.refreshStats();
			} catch (error) {
				console.warn('Background stats refresh failed:', error);
			}
		}, 0);
	}

	// ===== BATCH FETCH BY IDS =====

	/**
	 * Get multiple photos by IDs efficiently
	 */
	async getPhotosByIds(ids: string[]): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');
		if (ids.length === 0) return [];

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		const promises = ids.map(id =>
			new Promise<Photo | null>((resolve, reject) => {
				const request = store.get(id);
				request.onsuccess = () => resolve(request.result || null);
				request.onerror = () => reject(request.error);
			})
		);

		const results = await Promise.all(promises);
		return results.filter((p): p is Photo => p !== null);
	}

	/**
	 * Get multiple embeddings by photoIds efficiently
	 */
	async getEmbeddingsByIds(photoIds: string[]): Promise<Embedding[]> {
		if (!this.db) throw new Error('Database not initialized');
		if (photoIds.length === 0) return [];

		const transaction = this.db.transaction(['embeddings'], 'readonly');
		const store = transaction.objectStore('embeddings');

		const promises = photoIds.map(id =>
			new Promise<Embedding | null>((resolve, reject) => {
				const request = store.get(id);
				request.onsuccess = () => resolve(request.result || null);
				request.onerror = () => reject(request.error);
			})
		);

		const results = await Promise.all(promises);
		return results.filter((e): e is Embedding => e !== null);
	}

	// ===== SINGLE ITEM OPERATIONS =====

	/**
	 * Get a single photo by ID
	 */
	async getPhoto(id: string): Promise<Photo | undefined> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const request = store.get(id);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get embedding for a photo
	 */
	async getEmbedding(photoId: string): Promise<Embedding | undefined> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings'], 'readonly');
		const store = transaction.objectStore('embeddings');

		return new Promise((resolve, reject) => {
			const request = store.get(photoId);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get a single group by ID
	 */
	async getGroup(groupId: string): Promise<Group | undefined> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readonly');
		const store = transaction.objectStore('groups');

		return new Promise((resolve, reject) => {
			const request = store.get(groupId);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	// ===== WRITE OPERATIONS =====

	/**
	 * Add a photo to the database
	 */
	async addPhoto(photo: Partial<Photo> & { id: string; blob: Blob }): Promise<Photo> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readwrite');
		const store = transaction.objectStore('photos');

		const photoData: Photo = {
			id: photo.id,
			blob: photo.blob,
			mediaType: photo.mediaType || 'Photo',
			dateTaken: photo.dateTaken || new Date().toISOString(),
			fileName: photo.fileName,
			timestamp:
				photo.timestamp || (photo.dateTaken ? new Date(photo.dateTaken).getTime() : Date.now()),
			hasEmbedding: false,
			groupId: null
		};

		return new Promise((resolve, reject) => {
			const request = store.put(photoData);
			request.onsuccess = () => {
				this.cache.incrementPhotoCount(1);
				resolve(photoData);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Bulk add photos (more efficient)
	 */
	async addPhotos(photos: Array<Partial<Photo> & { id: string; blob: Blob }>): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readwrite');
		const store = transaction.objectStore('photos');

		const photoDataArray: Photo[] = photos.map(photo => ({
			id: photo.id,
			blob: photo.blob,
			mediaType: photo.mediaType || 'Photo',
			dateTaken: photo.dateTaken || new Date().toISOString(),
			fileName: photo.fileName,
			timestamp:
				photo.timestamp || (photo.dateTaken ? new Date(photo.dateTaken).getTime() : Date.now()),
			hasEmbedding: false,
			groupId: null
		}));

		const promises = photoDataArray.map((photoData) => {
			return new Promise<Photo>((resolve, reject) => {
				const request = store.put(photoData);
				request.onsuccess = () => resolve(photoData);
				request.onerror = () => reject(request.error);
			});
		});

		const results = await Promise.all(promises);
		this.cache.incrementPhotoCount(results.length);
		return results;
	}

	/**
	 * Add an embedding for a photo
	 */
	async addEmbedding(photoId: string, embedding: Float32Array | number[]): Promise<Embedding> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings', 'photos'], 'readwrite');
		const embeddingsStore = transaction.objectStore('embeddings');
		const photosStore = transaction.objectStore('photos');

		const embeddingData: Embedding = {
			photoId: photoId,
			embedding: Array.from(embedding),
			timestamp: Date.now()
		};

		return new Promise((resolve, reject) => {
			const embeddingRequest = embeddingsStore.put(embeddingData);

			embeddingRequest.onsuccess = () => {
				// Update photo to mark it has an embedding
				const photoRequest = photosStore.get(photoId);

				photoRequest.onsuccess = () => {
					const photo = photoRequest.result;
					if (photo) {
						photo.hasEmbedding = true;
						photosStore.put(photo);
					}
					this.cache.incrementEmbeddingCount(1);
					resolve(embeddingData);
				};

				photoRequest.onerror = () => reject(photoRequest.error);
			};

			embeddingRequest.onerror = () => reject(embeddingRequest.error);
		});
	}

	/**
	 * Create a group of similar photos
	 */
	async createGroup(photoIds: string[], similarityScore: number): Promise<Group> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups', 'photos'], 'readwrite');
		const groupsStore = transaction.objectStore('groups');
		const photosStore = transaction.objectStore('photos');

		const groupId = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const group: Group = {
			id: groupId,
			photoIds: photoIds,
			similarityScore: similarityScore,
			timestamp: Date.now(),
			reviewStatus: 'pending'
		};

		return new Promise((resolve, reject) => {
			const groupRequest = groupsStore.put(group);

			groupRequest.onsuccess = () => {
				// Update all photos with the group ID
				const updatePromises = photoIds.map((photoId) => {
					return new Promise<void>((resolvePhoto, rejectPhoto) => {
						const photoRequest = photosStore.get(photoId);

						photoRequest.onsuccess = () => {
							const photo = photoRequest.result;
							if (photo) {
								photo.groupId = groupId;
								const updateRequest = photosStore.put(photo);
								updateRequest.onsuccess = () => resolvePhoto();
								updateRequest.onerror = () => rejectPhoto(updateRequest.error);
							} else {
								resolvePhoto();
							}
						};

						photoRequest.onerror = () => rejectPhoto(photoRequest.error);
					});
				});

				Promise.all(updatePromises)
					.then(() => {
						this.cache.incrementGroupCount(1);
						resolve(group);
					})
					.catch(reject);
			};

			groupRequest.onerror = () => reject(groupRequest.error);
		});
	}

	/**
	 * Batch insert groups (for LSH grouping)
	 */
	async addGroupsBatch(groups: Group[]): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');
		if (groups.length === 0) return;

		const transaction = this.db.transaction(['groups'], 'readwrite');
		const store = transaction.objectStore('groups');

		for (const group of groups) {
			store.put(group);
		}

		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => {
				this.cache.incrementGroupCount(groups.length);
				resolve();
			};
			transaction.onerror = () => reject(transaction.error);
		});
	}

	/**
	 * Batch update photos
	 */
	async updatePhotosBatch(photos: Photo[]): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');
		if (photos.length === 0) return;

		const transaction = this.db.transaction(['photos'], 'readwrite');
		const store = transaction.objectStore('photos');

		for (const photo of photos) {
			store.put(photo);
		}

		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	/**
	 * Update group review status
	 */
	async updateGroupStatus(
		groupId: string,
		status: 'pending' | 'reviewed' | 'deleted'
	): Promise<Group> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readwrite');
		const store = transaction.objectStore('groups');

		return new Promise((resolve, reject) => {
			const request = store.get(groupId);

			request.onsuccess = () => {
				const group = request.result;
				if (group) {
					group.reviewStatus = status;
					const updateRequest = store.put(group);
					updateRequest.onsuccess = () => resolve(group);
					updateRequest.onerror = () => reject(updateRequest.error);
				} else {
					reject(new Error('Group not found'));
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Delete a group and remove group ID from photos
	 */
	async deleteGroup(groupId: string): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups', 'photos'], 'readwrite');
		const groupsStore = transaction.objectStore('groups');
		const photosStore = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const getGroupRequest = groupsStore.get(groupId);

			getGroupRequest.onsuccess = () => {
				const group = getGroupRequest.result;
				if (!group) {
					reject(new Error('Group not found'));
					return;
				}

				// Remove group ID from all photos
				const updatePromises = group.photoIds.map((photoId: string) => {
					return new Promise<void>((resolvePhoto, rejectPhoto) => {
						const photoRequest = photosStore.get(photoId);
						photoRequest.onsuccess = () => {
							const photo = photoRequest.result;
							if (photo && photo.groupId === groupId) {
								photo.groupId = null;
								photosStore.put(photo);
							}
							resolvePhoto();
						};
						photoRequest.onerror = () => rejectPhoto(photoRequest.error);
					});
				});

				Promise.all(updatePromises)
					.then(() => {
						const deleteRequest = groupsStore.delete(groupId);
						deleteRequest.onsuccess = () => {
							this.cache.incrementGroupCount(-1);
							resolve();
						};
						deleteRequest.onerror = () => reject(deleteRequest.error);
					})
					.catch(reject);
			};

			getGroupRequest.onerror = () => reject(getGroupRequest.error);
		});
	}

	/**
	 * Delete photos by IDs
	 */
	async deletePhotos(photoIds: string[]): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos', 'embeddings'], 'readwrite');
		const photosStore = transaction.objectStore('photos');
		const embeddingsStore = transaction.objectStore('embeddings');

		const promises = photoIds.map((photoId) => {
			return new Promise<void>((resolve, reject) => {
				const deletePhoto = photosStore.delete(photoId);
				const deleteEmbedding = embeddingsStore.delete(photoId);

				Promise.all([
					new Promise((res, rej) => {
						deletePhoto.onsuccess = () => res(null);
						deletePhoto.onerror = () => rej(deletePhoto.error);
					}),
					new Promise((res, rej) => {
						deleteEmbedding.onsuccess = () => res(null);
						deleteEmbedding.onerror = () => rej(deleteEmbedding.error);
					})
				])
					.then(() => resolve())
					.catch(reject);
			});
		});

		await Promise.all(promises);
		this.cache.incrementPhotoCount(-photoIds.length);
		this.cache.invalidate(); // Invalidate to recalculate
	}

	// ===== CLEAR OPERATIONS (Optimized with Batching) =====

	/**
	 * Clear only groups (for reindexing) - STREAMING VERSION
	 */
	async clearGroups(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		// Clear groups store
		const tx1 = this.db.transaction(['groups'], 'readwrite');
		await new Promise<void>((resolve, reject) => {
			const request = tx1.objectStore('groups').clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});

		// Reset groupId on all photos in batches
		await this.forEachPhotoBatch(async (batch) => {
			const updates = batch.map(photo => ({
				...photo,
				groupId: null
			}));
			await this.updatePhotosBatch(updates);
		}, 500);

		this.cache.invalidate();
	}

	/**
	 * Clear only embeddings (for reindexing) - STREAMING VERSION
	 */
	async clearEmbeddings(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		// Clear embeddings store
		const tx1 = this.db.transaction(['embeddings'], 'readwrite');
		await new Promise<void>((resolve, reject) => {
			const request = tx1.objectStore('embeddings').clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});

		// Reset hasEmbedding flag on all photos in batches
		await this.forEachPhotoBatch(async (batch) => {
			const updates = batch.map(photo => ({
				...photo,
				hasEmbedding: false,
				groupId: null
			}));
			await this.updatePhotosBatch(updates);
		}, 500);

		this.cache.invalidate();
	}

	/**
	 * Clear all data (for testing/reset)
	 */
	async clearAll(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(
			['photos', 'embeddings', 'groups', 'metadata', 'autoSelectJobs', 'selectedPhotos'],
			'readwrite'
		);

		const stores = [
			'photos',
			'embeddings',
			'groups',
			'metadata',
			'autoSelectJobs',
			'selectedPhotos'
		];

		await Promise.all(
			stores.map((storeName) => {
				return new Promise<void>((resolve, reject) => {
					const request = transaction.objectStore(storeName).clear();
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				});
			})
		);

		this.cache.invalidate();
	}

	// ===== METADATA OPERATIONS =====

	async getMetadata(key: string): Promise<unknown> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['metadata'], 'readonly');
		const store = transaction.objectStore('metadata');

		return new Promise((resolve, reject) => {
			const request = store.get(key);
			request.onsuccess = () => resolve(request.result?.value);
			request.onerror = () => reject(request.error);
		});
	}

	async setMetadata(key: string, value: unknown): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['metadata'], 'readwrite');
		const store = transaction.objectStore('metadata');

		return new Promise((resolve, reject) => {
			const request = store.put({ key, value, timestamp: Date.now() });
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	// ===== AUTO-SELECT JOBS =====

	async saveAutoSelectJob(job: {
		jobId: string;
		status: string;
		email: string;
		photoCount: number;
		createdAt: string;
	}): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['autoSelectJobs'], 'readwrite');
		const store = transaction.objectStore('autoSelectJobs');

		return new Promise((resolve, reject) => {
			const request = store.put(job);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async getAutoSelectJob(jobId: string): Promise<
		| {
				jobId: string;
				status: string;
				email: string;
				photoCount: number;
				createdAt: string;
		  }
		| undefined
	> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['autoSelectJobs'], 'readonly');
		const store = transaction.objectStore('autoSelectJobs');

		return new Promise((resolve, reject) => {
			const request = store.get(jobId);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	// ===== AI SUGGESTIONS =====

	async updatePhotoAISuggestion(
		photoId: string,
		reason: string,
		confidence: 'high' | 'medium' | 'low'
	): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readwrite');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const getRequest = store.get(photoId);

			getRequest.onsuccess = () => {
				const photo = getRequest.result;
				if (photo) {
					photo.aiSuggestionReason = reason;
					photo.aiSuggestionConfidence = confidence;
					const updateRequest = store.put(photo);
					updateRequest.onsuccess = () => resolve();
					updateRequest.onerror = () => reject(updateRequest.error);
				} else {
					resolve();
				}
			};

			getRequest.onerror = () => reject(getRequest.error);
		});
	}

	async clearAISuggestions(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		await this.forEachPhotoBatch(async (batch) => {
			const updates = batch.map(photo => ({
				...photo,
				aiSuggestionReason: undefined,
				aiSuggestionConfidence: undefined
			}));
			await this.updatePhotosBatch(updates);
		}, 500);
	}

	// ===== SELECTION MANAGEMENT =====

	async selectPhoto(photoId: string): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readwrite');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.put({ photoId, selectedAt: Date.now() });
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async unselectPhoto(photoId: string): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readwrite');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.delete(photoId);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async isPhotoSelected(photoId: string): Promise<boolean> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readonly');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.get(photoId);
			request.onsuccess = () => resolve(request.result !== undefined);
			request.onerror = () => reject(request.error);
		});
	}

	async getSelectedPhotosCount(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readonly');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.count();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async getSelectedPhotosBatch(offset: number = 0, limit: number = 1000): Promise<string[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readonly');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const photoIds: string[] = [];
			let skipped = 0;
			const request = store.openCursor();

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (skipped < offset) {
						skipped++;
						cursor.continue();
					} else if (photoIds.length < limit) {
						photoIds.push(cursor.value.photoId);
						cursor.continue();
					} else {
						resolve(photoIds);
					}
				} else {
					resolve(photoIds);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get all selected photo IDs
	 * WARNING: For large selections, use getSelectedPhotosBatch() instead
	 */
	async getAllSelectedPhotos(): Promise<string[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readonly');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.getAll();
			request.onsuccess = () => {
				const results = request.result.map((record: { photoId: string }) => record.photoId);
				resolve(results);
			};
			request.onerror = () => reject(request.error);
		});
	}

	async clearSelectedPhotos(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['selectedPhotos'], 'readwrite');
		const store = transaction.objectStore('selectedPhotos');

		return new Promise((resolve, reject) => {
			const request = store.clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async forEachSelectedPhotoBatch(
		callback: (photoIds: string[], batchIndex: number) => Promise<void>,
		batchSize: number = 1000
	): Promise<void> {
		let offset = 0;
		let batchIndex = 0;

		while (true) {
			const batch = await this.getSelectedPhotosBatch(offset, batchSize);
			if (batch.length === 0) break;

			await callback(batch, batchIndex);
			offset += batch.length;
			batchIndex++;

			if (batch.length < batchSize) break;
		}
	}
}

// Export singleton instance
const db = new LensDB();
export default db;
