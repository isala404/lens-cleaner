/**
 * IndexedDB wrapper for Lens Cleaner
 * Stores photos, embeddings, and groups
 */

const DB_NAME = 'LensCleanerDB';
const DB_VERSION = 1;

export interface Photo {
  id: string;
  base64: string;
  mediaType: string;
  dateTaken: string;
  fileName?: string;
  timestamp: number;
  hasEmbedding: boolean;
  groupId: string | null;
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
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Photos store
        if (!db.objectStoreNames.contains('photos')) {
          const photosStore = db.createObjectStore('photos', { keyPath: 'id' });
          photosStore.createIndex('timestamp', 'timestamp', { unique: false });
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
      };
    });
  }

  /**
   * Add a photo to the database
   */
  async addPhoto(photo: Partial<Photo> & { id: string; base64: string }): Promise<Photo> {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(['photos'], 'readwrite');
    const store = transaction.objectStore('photos');

    const photoData: Photo = {
      id: photo.id,
      base64: photo.base64,
      mediaType: photo.mediaType || 'Photo',
      dateTaken: photo.dateTaken || new Date().toISOString(),
      fileName: photo.fileName,
      timestamp: Date.now(),
      hasEmbedding: false,
      groupId: null
    };

    return new Promise((resolve, reject) => {
      const request = store.put(photoData);
      request.onsuccess = () => resolve(photoData);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Bulk add photos (more efficient)
   */
  async addPhotos(photos: Array<Partial<Photo> & { id: string; base64: string }>): Promise<Photo[]> {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(['photos'], 'readwrite');
    const store = transaction.objectStore('photos');

    const promises = photos.map(photo => {
      const photoData: Photo = {
        id: photo.id,
        base64: photo.base64,
        mediaType: photo.mediaType || 'Photo',
        dateTaken: photo.dateTaken || new Date().toISOString(),
        fileName: photo.fileName,
        timestamp: Date.now(),
        hasEmbedding: false,
        groupId: null
      };

      return new Promise<Photo>((resolve, reject) => {
        const request = store.put(photoData);
        request.onsuccess = () => resolve(photoData);
        request.onerror = () => reject(request.error);
      });
    });

    return Promise.all(promises);
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
   * Get all photos
   */
  async getAllPhotos(): Promise<Photo[]> {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(['photos'], 'readonly');
    const store = transaction.objectStore('photos');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get photos without embeddings (for processing)
   */
  async getPhotosWithoutEmbeddings(limit: number = 100): Promise<Photo[]> {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(['photos'], 'readonly');
    const store = transaction.objectStore('photos');

    return new Promise((resolve, reject) => {
      const results: Photo[] = [];
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (!cursor.value.hasEmbedding && results.length < limit) {
            results.push(cursor.value);
          }
          cursor.continue();
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

      embeddingRequest.onsuccess = () => {
        // Update photo to mark it has an embedding
        const photoRequest = photosStore.get(photoId);

        photoRequest.onsuccess = () => {
          const photo = photoRequest.result;
          if (photo) {
            photo.hasEmbedding = true;
            photosStore.put(photo);
          }
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
        const updatePromises = photoIds.map(photoId => {
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
          .then(() => resolve(group))
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
  async updateGroupStatus(groupId: string, status: 'pending' | 'reviewed' | 'deleted'): Promise<Group> {
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
        const updatePromises = group.photoIds.map(photoId => {
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

        Promise.all(updatePromises).then(() => {
          const deleteRequest = groupsStore.delete(groupId);
          deleteRequest.onsuccess = () => resolve();
          deleteRequest.onerror = () => reject(deleteRequest.error);
        }).catch(reject);
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

    const promises = photoIds.map(photoId => {
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
        ]).then(() => resolve()).catch(reject);
      });
    });

    await Promise.all(promises);
  }

  /**
   * Get/Set metadata
   */
  async getMetadata(key: string): Promise<any> {
    if (!this.db) throw new Error('Database not initialized');

    const transaction = this.db.transaction(['metadata'], 'readonly');
    const store = transaction.objectStore('metadata');

    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }

  async setMetadata(key: string, value: any): Promise<void> {
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
   * Get database statistics
   */
  async getStats(): Promise<Stats> {
    const [photos, embeddings, groups] = await Promise.all([
      this.getAllPhotos(),
      this.getAllEmbeddings(),
      this.getAllGroups()
    ]);

    const lastScrapeTime = await this.getMetadata('lastScrapeTime');
    const lastEmbeddingTime = await this.getMetadata('lastEmbeddingTime');
    const lastGroupingTime = await this.getMetadata('lastGroupingTime');

    return {
      totalPhotos: photos.length,
      photosWithEmbeddings: embeddings.length,
      totalGroups: groups.length,
      photosInGroups: photos.filter(p => p.groupId).length,
      lastScrapeTime,
      lastEmbeddingTime,
      lastGroupingTime
    };
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
      ['photos', 'embeddings', 'groups', 'metadata'],
      'readwrite'
    );

    const stores = ['photos', 'embeddings', 'groups', 'metadata'];

    return Promise.all(
      stores.map(storeName => {
        return new Promise<void>((resolve, reject) => {
          const request = transaction.objectStore(storeName).clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      })
    ).then(() => undefined);
  }
}

// Export singleton instance
const db = new LensDB();
export default db;
