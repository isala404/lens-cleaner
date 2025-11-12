/**
 * IndexedDB wrapper for Lens Cleaner
 * Stores photos, embeddings, and groups
 */

const DB_NAME = 'LensCleanerDB';
const DB_VERSION = 1;

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
	lastScrapeTime?: number;
	lastEmbeddingTime?: number;
	lastGroupingTime?: number;
}

class LensDB {
	private db: IDBDatabase | null = null;

	/**
	 * Initialize the database
	 */
	async init(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = async () => {
				this.db = request.result;
				// Initialize counters if this is the first run
				await this.initializeCounters();
				resolve(this.db);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Photos store
				if (!db.objectStoreNames.contains('photos')) {
					const photosStore = db.createObjectStore('photos', { keyPath: 'id' });
					photosStore.createIndex('timestamp', 'timestamp', { unique: false });
					photosStore.createIndex('dateTaken', 'dateTaken', { unique: false });
					photosStore.createIndex('hasEmbedding', 'hasEmbedding', { unique: false });
					photosStore.createIndex('groupId', 'groupId', { unique: false });
				}

				// Embeddings store (separate for better performance)
				if (!db.objectStoreNames.contains('embeddings')) {
					db.createObjectStore('embeddings', { keyPath: 'photoId' });
				}

				// Groups store
				if (!db.objectStoreNames.contains('groups')) {
					const groupsStore = db.createObjectStore('groups', { keyPath: 'id' });
					groupsStore.createIndex('timestamp', 'timestamp', { unique: false });
				}

				// Metadata store (for tracking scan progress, stats, etc.)
				if (!db.objectStoreNames.contains('metadata')) {
					db.createObjectStore('metadata', { keyPath: 'key' });
				}

				// Auto-select jobs store
				if (!db.objectStoreNames.contains('autoSelectJobs')) {
					const jobsStore = db.createObjectStore('autoSelectJobs', { keyPath: 'jobId' });
					jobsStore.createIndex('createdAt', 'createdAt', { unique: false });
					jobsStore.createIndex('status', 'status', { unique: false });
				}

				// Selection state store - for scalable photo selection
				if (!db.objectStoreNames.contains('selectedPhotos')) {
					const selectedStore = db.createObjectStore('selectedPhotos', { keyPath: 'photoId' });
					selectedStore.createIndex('selectedAt', 'selectedAt', { unique: false });
				}
			};
		});
	}

	/**
	 * Initialize counters on first run or if counters are missing
	 * This method counts existing data and sets up counters
	 */
	async initializeCounters(): Promise<void> {
		const photosCount = await this.getCounter('photos:count');
		const embeddingsCount = await this.getCounter('embeddings:count');
		const groupsCount = await this.getCounter('groups:count');

		// Only initialize if all counters are 0 (first run or migration)
		if (photosCount === 0 && embeddingsCount === 0 && groupsCount === 0) {
			// Check if there's actually any data to count
			const hasData = await this.hasAnyData();
			if (hasData) {
				console.log('Initializing counters from existing data...');
				// Count existing data (one-time operation)
				const [allPhotos, allEmbeddings, allGroups] = await Promise.all([
					this.getAllPhotos(),
					this.getAllEmbeddings(),
					this.getAllGroups()
				]);

				await this.setMetadata('photos:count', allPhotos.length);
				await this.setMetadata('embeddings:count', allEmbeddings.length);
				await this.setMetadata('groups:count', allGroups.length);

				console.log(
					`Counters initialized: ${allPhotos.length} photos, ${allEmbeddings.length} embeddings, ${allGroups.length} groups`
				);
			}
		}
	}

	/**
	 * Check if database has any data (for counter initialization)
	 */
	private async hasAnyData(): Promise<boolean> {
		if (!this.db) return false;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction(['photos'], 'readonly');
			const store = transaction.objectStore('photos');
			const request = store.count();

			request.onsuccess = () => resolve(request.result > 0);
			request.onerror = () => reject(request.error);
		});
	}

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
			request.onsuccess = async () => {
				await this.incrementCounter('photos:count', 1);
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

		const promises = photos.map((photo) => {
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

			return new Promise<Photo>((resolve, reject) => {
				const request = store.put(photoData);
				request.onsuccess = () => resolve(photoData);
				request.onerror = () => reject(request.error);
			});
		});

		const results = await Promise.all(promises);
		await this.incrementCounter('photos:count', photos.length);
		return results;
	}

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
	 * Get all photos, sorted by timestamp (newest first)
	 * Using timestamp (number) instead of dateTaken (string) ensures correct chronological ordering
	 */
	async getAllPhotos(): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const results: Photo[] = [];
			// Use timestamp index (numeric) instead of dateTaken (string) for reliable sorting
			const index = store.index('timestamp');
			const request = index.openCursor(null, 'prev'); // 'prev' = descending order (newest first)

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
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
	 * Get photos without embeddings (for processing), sorted by timestamp (oldest first)
	 * Note: Processing uses oldest first to maintain consistent order with processing queue
	 * Using timestamp (number) instead of dateTaken (string) ensures correct chronological ordering
	 */
	async getPhotosWithoutEmbeddings(limit: number = Infinity): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');

		return new Promise((resolve, reject) => {
			const results: Photo[] = [];
			// Use timestamp index (numeric) instead of dateTaken (string) for reliable sorting
			// Keep 'next' (ascending) for processing to maintain consistent queue order
			const index = store.index('timestamp');
			const request = index.openCursor(null, 'next'); // 'next' = ascending order (oldest first for processing)

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					if (!cursor.value.hasEmbedding && results.length < limit) {
						results.push(cursor.value);
					}
					if (results.length < limit) {
						cursor.continue();
					} else {
						resolve(results);
					}
				} else {
					resolve(results);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Add an embedding for a photo
	 */
	async addEmbedding(photoId: string, embedding: Float32Array | number[]): Promise<Embedding> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings', 'photos'], 'readwrite');
		const embeddingsStore = transaction.objectStore('embeddings');
		const photosStore = transaction.objectStore('photos');

		// Store embedding
		const embeddingData: Embedding = {
			photoId: photoId,
			embedding: Array.from(embedding), // Convert Float32Array to regular array
			timestamp: Date.now()
		};

		return new Promise((resolve, reject) => {
			const embeddingRequest = embeddingsStore.put(embeddingData);

			embeddingRequest.onsuccess = async () => {
				// Update photo to mark it has an embedding
				const photoRequest = photosStore.get(photoId);

				photoRequest.onsuccess = async () => {
					const photo = photoRequest.result;
					if (photo) {
						photo.hasEmbedding = true;
						photosStore.put(photo);
					}
					await this.incrementCounter('embeddings:count', 1);
					resolve(embeddingData);
				};

				photoRequest.onerror = () => reject(photoRequest.error);
			};

			embeddingRequest.onerror = () => reject(embeddingRequest.error);
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
	 * Get all embeddings
	 */
	async getAllEmbeddings(): Promise<Embedding[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings'], 'readonly');
		const store = transaction.objectStore('embeddings');

		return new Promise((resolve, reject) => {
			const request = store.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
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
					.then(async () => {
						await this.incrementCounter('groups:count', 1);
						resolve(group);
					})
					.catch(reject);
			};

			groupRequest.onerror = () => reject(groupRequest.error);
		});
	}

	/**
	 * Get all groups
	 */
	async getAllGroups(): Promise<Group[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readonly');
		const store = transaction.objectStore('groups');

		return new Promise((resolve, reject) => {
			const request = store.getAll();
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
					.then(async () => {
						const deleteRequest = groupsStore.delete(groupId);
						deleteRequest.onsuccess = async () => {
							await this.incrementCounter('groups:count', -1);
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

		let deletedPhotosCount = 0;
		let deletedEmbeddingsCount = 0;

		const promises = photoIds.map((photoId) => {
			return new Promise<void>((resolve, reject) => {
				const getPhoto = photosStore.get(photoId);
				getPhoto.onsuccess = () => {
					const photo = getPhoto.result;
					const hasEmbedding = photo?.hasEmbedding || false;

					const deletePhoto = photosStore.delete(photoId);
					const deleteEmbedding = embeddingsStore.delete(photoId);

					Promise.all([
						new Promise((res, rej) => {
							deletePhoto.onsuccess = () => {
								deletedPhotosCount++;
								res(null);
							};
							deletePhoto.onerror = () => rej(deletePhoto.error);
						}),
						new Promise((res, rej) => {
							deleteEmbedding.onsuccess = () => {
								if (hasEmbedding) deletedEmbeddingsCount++;
								res(null);
							};
							deleteEmbedding.onerror = () => rej(deleteEmbedding.error);
						})
					])
						.then(() => resolve())
						.catch(reject);
				};
				getPhoto.onerror = () => reject(getPhoto.error);
			});
		});

		await Promise.all(promises);
		await this.incrementCounter('photos:count', -deletedPhotosCount);
		await this.incrementCounter('embeddings:count', -deletedEmbeddingsCount);
	}

	/**
	 * Get/Set metadata
	 */
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

	/**
	 * Counter methods for stats (efficient counting without loading all data)
	 */
	async incrementCounter(key: string, amount: number = 1): Promise<number> {
		const current = ((await this.getMetadata(key)) as number) || 0;
		const newValue = current + amount;
		await this.setMetadata(key, newValue);
		return newValue;
	}

	async getCounter(key: string): Promise<number> {
		return ((await this.getMetadata(key)) as number) || 0;
	}

	/**
	 * Get photos in batches (pagination)
	 * @param offset - Number of photos to skip
	 * @param limit - Maximum number of photos to return
	 * @returns Photos sorted by timestamp (newest first)
	 */
	async getPhotosBatch(offset: number, limit: number): Promise<Photo[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readonly');
		const store = transaction.objectStore('photos');
		const index = store.index('timestamp');

		return new Promise((resolve, reject) => {
			const results: Photo[] = [];
			let skipped = 0;
			const request = index.openCursor(null, 'prev'); // Newest first

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (!cursor || results.length >= limit) {
					resolve(results);
					return;
				}

				if (skipped < offset) {
					skipped++;
					cursor.continue();
					return;
				}

				results.push(cursor.value);
				cursor.continue();
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get groups in batches (pagination)
	 * @param offset - Number of groups to skip
	 * @param limit - Maximum number of groups to return
	 * @returns Groups sorted by timestamp (newest first)
	 */
	async getGroupsBatch(offset: number, limit: number): Promise<Group[]> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups'], 'readonly');
		const store = transaction.objectStore('groups');
		const index = store.index('timestamp');

		return new Promise((resolve, reject) => {
			const results: Group[] = [];
			let skipped = 0;
			const request = index.openCursor(null, 'prev'); // Newest first

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (!cursor || results.length >= limit) {
					resolve(results);
					return;
				}

				if (skipped < offset) {
					skipped++;
					cursor.continue();
					return;
				}

				results.push(cursor.value);
				cursor.continue();
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get photos by IDs (for groups)
	 * @param photoIds - Array of photo IDs to fetch
	 * @returns Array of photos
	 */
	async getPhotosByIds(photoIds: string[]): Promise<Photo[]> {
		const photos: Photo[] = [];
		for (const id of photoIds) {
			const photo = await this.getPhoto(id);
			if (photo) photos.push(photo);
		}
		return photos;
	}

	/**
	 * Get database statistics (using counters for efficiency)
	 */
	async getStats(): Promise<Stats> {
		const totalPhotos = await this.getCounter('photos:count');
		const photosWithEmbeddings = await this.getCounter('embeddings:count');
		const totalGroups = await this.getCounter('groups:count');

		// Count photos in groups (only if needed)
		const photosInGroups = await this.countPhotosInGroups();

		const lastScrapeTime = (await this.getMetadata('lastScrapeTime')) as number | undefined;
		const lastEmbeddingTime = (await this.getMetadata('lastEmbeddingTime')) as number | undefined;
		const lastGroupingTime = (await this.getMetadata('lastGroupingTime')) as number | undefined;

		return {
			totalPhotos,
			photosWithEmbeddings,
			totalGroups,
			photosInGroups,
			lastScrapeTime,
			lastEmbeddingTime,
			lastGroupingTime
		};
	}

	/**
	 * Helper to count photos in groups (can be slow, but only called for stats)
	 */
	private async countPhotosInGroups(): Promise<number> {
		if (!this.db) throw new Error('Database not initialized');

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction(['groups'], 'readonly');
			const store = transaction.objectStore('groups');
			const request = store.openCursor();
			let count = 0;

			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
				if (cursor) {
					count += cursor.value.photoIds.length;
					cursor.continue();
				} else {
					resolve(count);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Clear only groups (for reindexing)
	 */
	async clearGroups(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['groups', 'photos'], 'readwrite');

		// Clear groups
		await new Promise<void>((resolve, reject) => {
			const request = transaction.objectStore('groups').clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});

		// Reset counter
		await this.setMetadata('groups:count', 0);

		// Reset groupId on all photos
		const photosStore = transaction.objectStore('photos');
		const allPhotos = await new Promise<Photo[]>((resolve, reject) => {
			const request = photosStore.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});

		for (const photo of allPhotos) {
			photo.groupId = null;
			await new Promise<void>((resolve, reject) => {
				const request = photosStore.put(photo);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
			});
		}
	}

	/**
	 * Clear only embeddings (for reindexing)
	 */
	async clearEmbeddings(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['embeddings', 'photos'], 'readwrite');

		// Clear embeddings
		await new Promise<void>((resolve, reject) => {
			const request = transaction.objectStore('embeddings').clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});

		// Reset counter
		await this.setMetadata('embeddings:count', 0);

		// Reset hasEmbedding flag on all photos
		const photosStore = transaction.objectStore('photos');
		const allPhotos = await new Promise<Photo[]>((resolve, reject) => {
			const request = photosStore.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});

		for (const photo of allPhotos) {
			photo.hasEmbedding = false;
			await new Promise<void>((resolve, reject) => {
				const request = photosStore.put(photo);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
			});
		}
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

		// Note: counters are stored in metadata, so they're already cleared above
		// But we'll reinitialize them to 0 explicitly for clarity
		await this.setMetadata('photos:count', 0);
		await this.setMetadata('embeddings:count', 0);
		await this.setMetadata('groups:count', 0);
	}

	/**
	 * Save auto-select job
	 */
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

	/**
	 * Get auto-select job by ID
	 */
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

	/**
	 * Update photo with AI suggestion
	 */
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

	/**
	 * Clear AI suggestions from all photos
	 */
	async clearAISuggestions(): Promise<void> {
		if (!this.db) throw new Error('Database not initialized');

		const transaction = this.db.transaction(['photos'], 'readwrite');
		const photosStore = transaction.objectStore('photos');

		const allPhotos = await new Promise<Photo[]>((resolve, reject) => {
			const request = photosStore.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});

		for (const photo of allPhotos) {
			photo.aiSuggestionReason = undefined;
			photo.aiSuggestionConfidence = undefined;
			await new Promise<void>((resolve, reject) => {
				const request = photosStore.put(photo);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
			});
		}
	}

	// ===== SELECTION MANAGEMENT =====
	// Methods for managing photo selection state in IndexedDB
	// This allows scalable selection of millions of photos without memory constraints

	/**
	 * Mark a photo as selected
	 */
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

	/**
	 * Mark a photo as unselected
	 */
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

	/**
	 * Check if a photo is selected
	 */
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

	/**
	 * Get the total count of selected photos
	 */
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

	/**
	 * Get a batch of selected photo IDs
	 * @param offset - Number of records to skip
	 * @param limit - Maximum number of records to return
	 */
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
					// Skip until we reach the offset
					if (skipped < offset) {
						skipped++;
						cursor.continue();
						return;
					}

					// Collect photo IDs until we reach the limit
					if (photoIds.length < limit) {
						photoIds.push(cursor.value.photoId);
						cursor.continue();
					} else {
						resolve(photoIds);
					}
				} else {
					// No more records
					resolve(photoIds);
				}
			};

			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Get all selected photo IDs
	 * WARNING: This loads all IDs into memory. Use getSelectedPhotosBatch() for large selections.
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

	/**
	 * Clear all selected photos
	 */
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

	/**
	 * Iterate through all selected photos in batches and call a callback for each batch
	 * This is useful for processing large selections without loading all IDs into memory
	 * @param batchSize - Number of photo IDs to process per batch
	 * @param callback - Function to call for each batch of photo IDs
	 */
	async forEachSelectedPhotoBatch(
		callback: (photoIds: string[], batchIndex: number) => Promise<void>,
		batchSize: number = 1000
	): Promise<void> {
		let offset = 0;
		let batchIndex = 0;

		while (true) {
			const batch = await this.getSelectedPhotosBatch(offset, batchSize);
			if (batch.length === 0) {
				break;
			}

			await callback(batch, batchIndex);
			offset += batch.length;
			batchIndex++;

			// If we got fewer results than the batch size, we've reached the end
			if (batch.length < batchSize) {
				break;
			}
		}
	}
}

// Export singleton instance
const db = new LensDB();
export default db;
