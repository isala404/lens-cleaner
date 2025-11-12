# IndexedDB Optimization Plan for Lens Cleaner
## Scaling from 20K to 1M+ Images

**Author:** Claude
**Date:** 2025-11-12
**Status:** DRAFT - Awaiting Approval

---

## Executive Summary

The current implementation loads **all photos, embeddings, and groups into memory** using `getAll()` calls. At 20K images, this attempts to load ~40GB into browser memory, causing crashes. This plan implements **streaming, batching, and lazy-loading patterns** used by Google Photos, Amazon S3, and modern web-scale applications to handle 1M+ images efficiently.

### Current State
- ✅ Good: Separate stores for photos/embeddings/groups
- ✅ Good: Cursor-based pagination exists for `selectedPhotos` (v3)
- ✅ Good: Blobs stored efficiently (not base64)
- 🚨 Critical: `getAllPhotos()` loads 2MB × 20K = **40GB**
- 🚨 Critical: `getAllEmbeddings()` loads 3KB × 100K = **300MB**
- 🚨 Critical: Grouping algorithm is O(n²) - won't scale past 50K photos

### Target State
- 📊 Constant memory usage (~200MB regardless of dataset size)
- 🚀 Sub-second initial page load
- ⚡ Virtual scrolling with infinite scroll
- 🔄 Streaming aggregations (counts, stats)
- 🧠 Locality-Sensitive Hashing (LSH) for O(n log n) grouping
- 💾 localStorage metadata cache for instant UI rendering

---

## Part 1: Core Problems & Solutions

### Problem 1: Memory Explosion from `getAll()` Calls

**Current Code (db.ts:196-220):**
```typescript
async getAllPhotos(): Promise<Photo[]> {
    const request = store.getAll(); // Loads EVERYTHING
    return request.result;
}
```

**Impact at Scale:**
| Photos | Blobs Loaded | RAM Used | Result |
|--------|--------------|----------|--------|
| 1,000 | 2GB | Acceptable | ✅ Works |
| 20,000 | 40GB | Browser crash | 💥 |
| 100,000 | 200GB | Impossible | 💥 |
| 1,000,000 | 2TB | Impossible | 💥 |

**Solution: Cursor-Based Streaming (Google Photos Pattern)**

The codebase **already implements this correctly** in `selectedPhotos` store (db.ts:861-897). Apply this pattern to ALL queries:

```typescript
// Template from existing getSelectedPhotosBatch()
async getPhotosBatch(offset: number, limit: number): Promise<Photo[]> {
    return new Promise((resolve, reject) => {
        const photos: Photo[] = [];
        let skipped = 0;
        const request = store.index('timestamp').openCursor(null, 'prev');

        request.onsuccess = (event) => {
            const cursor = event.target.result;
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
    });
}
```

**Batch Sizes (Research-Based):**
- **UI Display:** 50-100 photos per page (Google Photos uses 50)
- **Background Processing:** 100-500 photos per batch (depends on operation)
- **Embeddings:** 1000 embeddings per batch (small objects)
- **Groups:** 500 groups per batch

---

### Problem 2: Aggregations Load Full Dataset

**Current Code (db.ts:566-573):**
```typescript
async getStats(): Promise<Stats> {
    const photos = await this.getAllPhotos(); // Loads 40GB!
    const embeddings = await this.getAllEmbeddings(); // Loads 300MB
    const groups = await this.getAllGroups();

    return {
        totalPhotos: photos.length,
        totalEmbeddings: embeddings.length,
        // ...
    };
}
```

**Solution: Streaming Aggregations + localStorage Cache (Amazon CloudWatch Pattern)**

```typescript
// Phase 1: Use IndexedDB count() - instant O(1)
async getPhotoCount(): Promise<number> {
    const tx = this.db.transaction('photos', 'readonly');
    const request = tx.objectStore('photos').count();
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
    });
}

// Phase 2: Cache in localStorage for instant access
async getCachedStats(): Promise<Stats> {
    const cached = localStorage.getItem('lens_stats_cache');
    if (cached) {
        const stats = JSON.parse(cached);
        // Return cached immediately, refresh in background
        this.refreshStats(); // async, don't await
        return stats;
    }
    return await this.refreshStats();
}

async refreshStats(): Promise<Stats> {
    const stats = {
        totalPhotos: await this.getPhotoCount(),
        totalEmbeddings: await this.getEmbeddingCount(),
        totalGroups: await this.getGroupCount(),
        photosWithEmbeddings: await this.getPhotosWithEmbeddingCount(),
        lastUpdated: Date.now()
    };
    localStorage.setItem('lens_stats_cache', JSON.stringify(stats));
    return stats;
}

// For counts with conditions, use cursor with counter
async getPhotosWithEmbeddingCount(): Promise<number> {
    return new Promise((resolve) => {
        const index = store.index('hasEmbedding');
        const request = index.count(IDBKeyRange.only(true));
        request.onsuccess = () => resolve(request.result);
    });
}
```

**localStorage Schema:**
```typescript
interface LocalStorageCache {
    // Stats (updated after each operation)
    lens_stats_cache: {
        totalPhotos: number;
        totalEmbeddings: number;
        totalGroups: number;
        photosWithEmbeddings: number;
        selectedCount: number;
        lastUpdated: number; // timestamp
    };

    // Pagination state
    lens_pagination_state: {
        currentPage: number;
        pageSize: number;
        scrollPosition: number;
    };

    // Processing progress
    lens_embedding_progress: {
        completed: number;
        total: number;
        lastProcessedId: string;
        batchSize: number;
    };

    lens_grouping_progress: {
        completed: number;
        total: number;
        lastProcessedBatch: number;
    };

    // UI state
    lens_view_mode: 'grid' | 'groups' | 'ungrouped';
    lens_sort_order: 'newest' | 'oldest';
}
```

---

### Problem 3: O(n²) Grouping Algorithm

**Current Code (grouping.ts:49-214):**
```typescript
async groupSimilarPhotosBatched(
    photos: Photo[], // ALL photos loaded
    embeddingMap: Map<string, number[]>, // ALL embeddings
    ...
) {
    for (let i = 0; i < photos.length; i++) {
        for (let j = i + 1; j < photos.length; j++) {
            // Compare every pair: O(n²)
        }
    }
}
```

**Complexity Analysis:**
| Photos | Comparisons | Time (est.) |
|--------|-------------|-------------|
| 1,000 | 500,000 | 1s |
| 20,000 | 200,000,000 | 200s (3min) |
| 100,000 | 5,000,000,000 | 5000s (83min) |
| 1,000,000 | 500,000,000,000 | 5.7 days |

**Solution: Locality-Sensitive Hashing (LSH) - Google's Approach**

LSH reduces similarity search from O(n²) to **O(n log n)** by creating "buckets" of similar items.

```typescript
// Concept: Hash embeddings so similar vectors get same hash
// Only compare photos within same hash bucket

class LSHIndex {
    private hyperplanes: number[][];  // Random projection vectors
    private buckets: Map<string, string[]>; // hash -> photoIds

    constructor(
        private dimensions: number = 768,  // DINOv2 embedding size
        private numHashFunctions: number = 16,  // Higher = better precision
        private numHashTables: number = 4  // Higher = better recall
    ) {
        this.hyperplanes = this.generateRandomHyperplanes();
        this.buckets = new Map();
    }

    // Generate random projection vectors (Google's SimHash)
    private generateRandomHyperplanes(): number[][] {
        const planes: number[][] = [];
        for (let i = 0; i < this.numHashFunctions; i++) {
            const plane: number[] = [];
            for (let j = 0; j < this.dimensions; j++) {
                plane.push(Math.random() * 2 - 1); // Random [-1, 1]
            }
            planes.push(plane);
        }
        return planes;
    }

    // Hash an embedding to a bucket string
    private hashEmbedding(embedding: number[]): string {
        let hash = '';
        for (const hyperplane of this.hyperplanes) {
            const dotProduct = embedding.reduce(
                (sum, val, idx) => sum + val * hyperplane[idx],
                0
            );
            hash += dotProduct > 0 ? '1' : '0';
        }
        return hash;
    }

    // Add photo to index (streaming, one at a time)
    addPhoto(photoId: string, embedding: number[]): void {
        const hash = this.hashEmbedding(embedding);
        if (!this.buckets.has(hash)) {
            this.buckets.set(hash, []);
        }
        this.buckets.get(hash)!.push(photoId);
    }

    // Find candidate duplicates (only check same bucket)
    getCandidates(photoId: string, embedding: number[]): string[] {
        const hash = this.hashEmbedding(embedding);
        return this.buckets.get(hash) || [];
    }
}

// New grouping algorithm
async groupPhotosWithLSH(
    batchSize: number = 1000,
    threshold: number = 0.85
): Promise<void> {
    const lsh = new LSHIndex();
    const embeddingCount = await db.getEmbeddingCount();
    let processed = 0;

    // Phase 1: Build LSH index (streaming)
    while (processed < embeddingCount) {
        const embeddingBatch = await db.getEmbeddingsBatch(processed, batchSize);
        for (const emb of embeddingBatch) {
            lsh.addPhoto(emb.photoId, emb.embedding);
        }
        processed += embeddingBatch.length;
        // Update progress UI
    }

    // Phase 2: Find duplicates within buckets
    processed = 0;
    const groups: Map<string, Set<string>> = new Map();

    while (processed < embeddingCount) {
        const embeddingBatch = await db.getEmbeddingsBatch(processed, batchSize);

        for (const emb of embeddingBatch) {
            // Only compare with candidates in same bucket
            const candidates = lsh.getCandidates(emb.photoId, emb.embedding);

            for (const candidateId of candidates) {
                if (candidateId === emb.photoId) continue;

                const candidate = await db.getEmbedding(candidateId);
                const similarity = cosineSimilarity(emb.embedding, candidate.embedding);

                if (similarity >= threshold) {
                    // Add to group
                    const groupId = this.findOrCreateGroup(groups, emb.photoId);
                    groups.get(groupId)!.add(candidateId);
                }
            }
        }

        processed += embeddingBatch.length;
    }

    // Phase 3: Save groups in batches
    await this.saveGroupsBatched(groups);
}
```

**LSH Performance:**
| Photos | Comparisons (LSH) | Time (est.) | Speedup |
|--------|-------------------|-------------|---------|
| 20,000 | ~400,000 | 4s | 50x |
| 100,000 | ~2,000,000 | 20s | 250x |
| 1,000,000 | ~20,000,000 | 200s | 2500x |

**Alternative: Approximate Nearest Neighbors (ANN)**
- Use library: `hnswlib-wasm` (HNSW algorithm)
- Even faster: O(log n) per query
- Trade-off: More complex, requires WASM

---

### Problem 4: UI Loads All Photos at Once

**Current Code (App.svelte:177-180):**
```typescript
async function refreshData() {
    photos = await db.getAllPhotos(); // 40GB!
    groups = await db.getAllGroups();
    // ... render everything
}
```

**Solution: Virtual Scrolling + Infinite Scroll (Amazon Product Listing Pattern)**

```typescript
// Store: Only keep visible photos in memory
interface PhotoGridState {
    visiblePhotos: Photo[]; // Only 100 photos at a time
    totalCount: number; // From localStorage
    currentPage: number;
    pageSize: number;
    isLoading: boolean;
}

// Load first page on mount
async function initializePhotoGrid() {
    const stats = await db.getCachedStats();
    gridState = {
        visiblePhotos: await db.getPhotosBatch(0, 100),
        totalCount: stats.totalPhotos,
        currentPage: 0,
        pageSize: 100,
        isLoading: false
    };
}

// Load next page when user scrolls
async function loadNextPage() {
    if (gridState.isLoading) return;

    gridState.isLoading = true;
    const nextPage = gridState.currentPage + 1;
    const offset = nextPage * gridState.pageSize;

    const nextBatch = await db.getPhotosBatch(offset, gridState.pageSize);

    // Windowing: Remove old photos if too many in memory
    if (gridState.visiblePhotos.length > 300) {
        // Keep only last 200 photos + new batch
        const oldPhotos = gridState.visiblePhotos.slice(0, 100);
        oldPhotos.forEach(photo => {
            // Revoke blob URLs to free memory
            if (blobUrlCache.has(photo.id)) {
                URL.revokeObjectURL(blobUrlCache.get(photo.id)!);
                blobUrlCache.delete(photo.id);
            }
        });
        gridState.visiblePhotos = [
            ...gridState.visiblePhotos.slice(100),
            ...nextBatch
        ];
    } else {
        gridState.visiblePhotos = [...gridState.visiblePhotos, ...nextBatch];
    }

    gridState.currentPage = nextPage;
    gridState.isLoading = false;
}
```

**Virtual Scrolling Library Recommendation:**
- Use `svelte-virtual-list` or `svelte-window`
- Renders only visible items (50-100 photos)
- Recycles DOM elements
- Memory: ~200MB constant (regardless of total photos)

---

### Problem 5: Ungrouped Photos Query

**Current Code (App.svelte:743-754):**
```typescript
async function loadUngroupedPhotos() {
    const allPhotos = await db.getAllPhotos(); // 40GB!
    const allGroups = await db.getAllGroups();
    const groupedIds = new Set(allGroups.flatMap(g => g.photoIds));
    ungroupedPhotos = allPhotos.filter(p =>
        p.hasEmbedding && !groupedIds.has(p.id)
    );
}
```

**Solution: Index-Based Query with Streaming**

```typescript
// Add compound index to photos store
photosStore.createIndex(
    'embeddingAndGroup',
    ['hasEmbedding', 'groupId'],
    { unique: false }
);

// Query directly for ungrouped photos with embeddings
async getUngroupedPhotosBatch(
    offset: number,
    limit: number
): Promise<Photo[]> {
    return new Promise((resolve) => {
        const photos: Photo[] = [];
        let skipped = 0;

        // Query index: hasEmbedding=true AND groupId=null
        const range = IDBKeyRange.only([true, null]);
        const request = store.index('embeddingAndGroup')
            .openCursor(range);

        request.onsuccess = (event) => {
            const cursor = event.target.result;
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
    });
}

// Count ungrouped photos efficiently
async getUngroupedPhotoCount(): Promise<number> {
    return new Promise((resolve) => {
        const range = IDBKeyRange.only([true, null]);
        const request = store.index('embeddingAndGroup').count(range);
        request.onsuccess = () => resolve(request.result);
    });
}
```

---

## Part 2: Implementation Phases

### Phase 1: Foundation (Critical Path - 1 week)

**Goal:** Stop loading all data into memory, add metadata caching

#### 1.1: Add Batched Read Methods to db.ts

**Files to modify:** `chrome-extensions/src/lib/db.ts`

Add these methods (using `getSelectedPhotosBatch` as template):
```typescript
// Photos
getPhotosBatch(offset: number, limit: number): Promise<Photo[]>
getPhotoCount(): Promise<number>
forEachPhotoBatch(callback: (batch: Photo[]) => Promise<void>, batchSize: number): Promise<void>

// Embeddings
getEmbeddingsBatch(offset: number, limit: number): Promise<Embedding[]>
getEmbeddingCount(): Promise<number>
forEachEmbeddingBatch(callback: (batch: Embedding[]) => Promise<void>, batchSize: number): Promise<void>

// Groups
getGroupsBatch(offset: number, limit: number): Promise<Group[]>
getGroupCount(): Promise<number>

// Batch fetching by IDs
getPhotosByIds(ids: string[]): Promise<Photo[]> // Optimized batch fetch
```

**Testing:**
- Test with 100, 1000, 10000 photo datasets
- Verify memory stays under 500MB
- Benchmark query times

#### 1.2: localStorage Metadata Cache

**Files to modify:** `chrome-extensions/src/lib/db.ts`

```typescript
class MetadataCache {
    private readonly CACHE_KEY = 'lens_metadata_cache';
    private readonly STATS_KEY = 'lens_stats_cache';

    async getCachedStats(): Promise<Stats | null> {
        const cached = localStorage.getItem(this.STATS_KEY);
        if (!cached) return null;

        const stats = JSON.parse(cached);
        // Cache valid for 5 minutes
        if (Date.now() - stats.lastUpdated > 5 * 60 * 1000) {
            return null;
        }
        return stats;
    }

    async updateStats(partial: Partial<Stats>): Promise<void> {
        const current = await this.getCachedStats() || {};
        const updated = {
            ...current,
            ...partial,
            lastUpdated: Date.now()
        };
        localStorage.setItem(this.STATS_KEY, JSON.stringify(updated));
    }

    // Increment counters after operations
    incrementPhotoCount(delta: number = 1): void {
        const stats = this.getCachedStats();
        if (stats) {
            stats.totalPhotos += delta;
            localStorage.setItem(this.STATS_KEY, JSON.stringify(stats));
        }
    }
}
```

**Update these operations:**
- `addPhoto()` → increment photo count
- `deletePhoto()` → decrement photo count
- `addEmbedding()` → increment embedding count
- `addGroup()` → increment group count

#### 1.3: Deprecate Dangerous Methods

**Files to modify:** `chrome-extensions/src/lib/db.ts`

```typescript
// Mark as deprecated, log warnings
/** @deprecated Use getPhotosBatch() instead - this loads all photos into memory */
async getAllPhotos(): Promise<Photo[]> {
    console.error(
        'getAllPhotos() is deprecated and will cause memory issues at scale. ' +
        'Use getPhotosBatch() or forEachPhotoBatch() instead.'
    );
    // Keep implementation for backward compatibility
    return this.legacyGetAllPhotos();
}
```

**Deprecated methods:**
- `getAllPhotos()`
- `getAllEmbeddings()`
- `getAllGroups()`

---

### Phase 2: Update Core Operations (1-2 weeks)

**Goal:** Replace all `getAll()` calls with batched equivalents

#### 2.1: Refactor appStore.ts

**Files to modify:** `chrome-extensions/src/stores/appStore.ts`

**Line 177-180: refreshData()**
```typescript
// OLD
async refreshData() {
    photos = await db.getAllPhotos(); // 40GB
    groups = await db.getAllGroups();
}

// NEW
async refreshData() {
    // Load only metadata, no photos
    const stats = await db.getCachedStats();
    photoCount = stats.totalPhotos;
    groupCount = stats.totalGroups;

    // Photos loaded on-demand by UI components
}
```

**Line 405-466: groupPhotos()**
```typescript
// OLD
async groupPhotos() {
    const allPhotos = await db.getAllPhotos();
    const withEmbeddings = allPhotos.filter(p => p.hasEmbedding);
    const embMap = new Map(embeddings.map(e => [e.photoId, e.embedding]));
    await grouper.groupSimilarPhotosBatched(withEmbeddings, embMap, ...);
}

// NEW
async groupPhotos() {
    // Use LSH index (Phase 3)
    await grouper.groupPhotosWithLSH({
        batchSize: 1000,
        threshold: 0.85,
        onProgress: (completed, total) => {
            updateProgress(completed / total);
        }
    });
}
```

**Line 745-754: loadUngroupedPhotos()**
```typescript
// OLD
async function loadUngroupedPhotos() {
    const allPhotos = await db.getAllPhotos();
    const allGroups = await db.getAllGroups();
    ungroupedPhotos = allPhotos.filter(...);
}

// NEW
async function loadUngroupedPhotos() {
    // Use compound index from Phase 1
    const count = await db.getUngroupedPhotoCount();
    ungroupedPhotoCount = count;

    // Load first page only
    ungroupedPhotos = await db.getUngroupedPhotosBatch(0, 100);
}
```

#### 2.2: Refactor Stats Calculation

**File:** `chrome-extensions/src/lib/db.ts` (lines 566-573)

```typescript
// OLD
async getStats(): Promise<Stats> {
    const photos = await this.getAllPhotos();
    const embeddings = await this.getAllEmbeddings();
    // ...
}

// NEW
async getStats(): Promise<Stats> {
    // Try cache first
    const cached = await this.metadataCache.getCachedStats();
    if (cached) {
        // Refresh in background
        this.refreshStatsBackground();
        return cached;
    }

    // Calculate from IndexedDB counts (fast O(1) operations)
    const stats = {
        totalPhotos: await this.getPhotoCount(),
        totalEmbeddings: await this.getEmbeddingCount(),
        totalGroups: await this.getGroupCount(),
        photosWithEmbeddings: await this.getPhotosWithEmbeddingCount(),
        selectedPhotos: await this.getSelectedPhotoCount(),
        lastUpdated: Date.now()
    };

    await this.metadataCache.updateStats(stats);
    return stats;
}

private async refreshStatsBackground(): Promise<void> {
    // Non-blocking refresh
    setTimeout(async () => {
        const stats = await this.getStats();
        await this.metadataCache.updateStats(stats);
    }, 0);
}
```

#### 2.3: Refactor Reindexing Operations

**File:** `chrome-extensions/src/lib/db.ts` (lines 588-649)

```typescript
// OLD
async clearEmbeddings(): Promise<void> {
    const allPhotos = await this.getAllPhotos(); // 40GB!
    for (const photo of allPhotos) {
        photo.hasEmbedding = false;
        await photosStore.put(photo);
    }
}

// NEW
async clearEmbeddings(): Promise<void> {
    // Clear embeddings store
    await new Promise<void>((resolve) => {
        const tx = this.db.transaction('embeddings', 'readwrite');
        const request = tx.objectStore('embeddings').clear();
        request.onsuccess = () => resolve();
    });

    // Batch update photos.hasEmbedding flag
    await this.forEachPhotoBatch(async (batch) => {
        const tx = this.db.transaction('photos', 'readwrite');
        const store = tx.objectStore('photos');

        for (const photo of batch) {
            photo.hasEmbedding = false;
            photo.groupId = null;
            store.put(photo);
        }

        await new Promise(resolve => tx.oncomplete = resolve);
    }, 500); // 500 photos per batch

    // Update cache
    await this.metadataCache.updateStats({
        totalEmbeddings: 0,
        photosWithEmbeddings: 0
    });
}
```

---

### Phase 3: Virtual Scrolling UI (1 week)

**Goal:** Implement infinite scroll with windowed rendering

#### 3.1: Install Virtual Scrolling Library

```bash
npm install svelte-window
```

#### 3.2: Refactor PhotoGrid Component

**File:** `chrome-extensions/src/components/PhotoGrid.svelte`

```svelte
<script lang="ts">
    import { Window } from 'svelte-window';
    import type { Photo } from '$lib/db';

    export let totalPhotoCount: number; // From metadata cache

    let visiblePhotos: Photo[] = [];
    let loadedRange = { start: 0, end: 0 };
    const BATCH_SIZE = 100;
    const WINDOW_SIZE = 300; // Keep 300 photos in memory

    async function loadPhotoRange(startIndex: number, endIndex: number) {
        // Only load if not already loaded
        if (startIndex >= loadedRange.start && endIndex <= loadedRange.end) {
            return;
        }

        const offset = Math.max(0, startIndex - 50); // Load 50 extra
        const limit = Math.min(BATCH_SIZE, endIndex - startIndex + 100);

        const newPhotos = await db.getPhotosBatch(offset, limit);

        // Window management: Keep only visible + buffer
        visiblePhotos = newPhotos;
        loadedRange = { start: offset, end: offset + newPhotos.length };

        // Cleanup old blob URLs
        cleanupOldBlobUrls();
    }

    function cleanupOldBlobUrls() {
        // Revoke URLs for photos outside visible range
        const visibleIds = new Set(visiblePhotos.map(p => p.id));
        for (const [id, url] of blobUrlCache.entries()) {
            if (!visibleIds.has(id)) {
                URL.revokeObjectURL(url);
                blobUrlCache.delete(id);
            }
        }
    }
</script>

<div class="photo-grid-container">
    <Window
        items={Array(totalPhotoCount).fill(null)}
        height="800"
        {loadPhotoRange}
    >
        {#each visiblePhotos as photo (photo.id)}
            <PhotoCard {photo} />
        {/each}
    </Window>
</div>
```

**Alternative: Custom Intersection Observer**
```typescript
// Simpler approach using Intersection Observer
let sentinel: HTMLElement;
const observer = new IntersectionObserver(async (entries) => {
    if (entries[0].isIntersecting && !isLoading) {
        await loadNextPage();
    }
});

onMount(() => {
    observer.observe(sentinel);
});
```

#### 3.3: Update App.svelte Main Component

**File:** `chrome-extensions/src/App.svelte`

```typescript
// Remove photos array, use counts instead
let photoCount: number = 0;
let groupCount: number = 0;
let embeddingCount: number = 0;

async function initializeApp() {
    const stats = await db.getCachedStats();
    photoCount = stats.totalPhotos;
    groupCount = stats.totalGroups;
    embeddingCount = stats.totalEmbeddings;

    // Photos loaded on-demand by PhotoGrid
}
```

---

### Phase 4: LSH-Based Grouping (2 weeks)

**Goal:** Replace O(n²) algorithm with O(n log n) LSH

#### 4.1: Implement LSH Index

**New file:** `chrome-extensions/src/lib/lsh.ts`

```typescript
export interface LSHConfig {
    dimensions: number; // 768 for DINOv2
    numHashFunctions: number; // 16-32 (precision)
    numHashTables: number; // 4-8 (recall)
    bucketThreshold: number; // Max bucket size before splitting
}

export class LSHIndex {
    private hyperplanes: number[][][]; // [table][function][dimension]
    private hashTables: Map<string, Set<string>>[]; // buckets per table

    constructor(private config: LSHConfig) {
        this.hyperplanes = this.generateHyperplanes();
        this.hashTables = Array(config.numHashTables)
            .fill(null)
            .map(() => new Map());
    }

    // Generate random projection vectors
    private generateHyperplanes(): number[][][] {
        const tables: number[][][] = [];

        for (let t = 0; t < this.config.numHashTables; t++) {
            const table: number[][] = [];
            for (let f = 0; f < this.config.numHashFunctions; f++) {
                const plane: number[] = [];
                for (let d = 0; d < this.config.dimensions; d++) {
                    // Gaussian random: better than uniform for LSH
                    plane.push(this.gaussianRandom());
                }
                // Normalize to unit vector
                const norm = Math.sqrt(plane.reduce((s, v) => s + v*v, 0));
                table.push(plane.map(v => v / norm));
            }
            tables.push(table);
        }

        return tables;
    }

    private gaussianRandom(): number {
        // Box-Muller transform
        const u1 = Math.random();
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    // Hash embedding for specific table
    private hashForTable(embedding: number[], tableIdx: number): string {
        const hyperplanes = this.hyperplanes[tableIdx];
        let hash = '';

        for (const plane of hyperplanes) {
            const dotProduct = embedding.reduce(
                (sum, val, idx) => sum + val * plane[idx],
                0
            );
            hash += dotProduct >= 0 ? '1' : '0';
        }

        return hash;
    }

    // Add photo to all hash tables
    addPhoto(photoId: string, embedding: number[]): void {
        for (let t = 0; t < this.config.numHashTables; t++) {
            const hash = this.hashForTable(embedding, t);
            const table = this.hashTables[t];

            if (!table.has(hash)) {
                table.set(hash, new Set());
            }
            table.get(hash)!.add(photoId);
        }
    }

    // Query: Get candidate duplicates
    getCandidates(photoId: string, embedding: number[]): Set<string> {
        const candidates = new Set<string>();

        // Check all hash tables (union of results)
        for (let t = 0; t < this.config.numHashTables; t++) {
            const hash = this.hashForTable(embedding, t);
            const bucket = this.hashTables[t].get(hash);

            if (bucket) {
                bucket.forEach(id => {
                    if (id !== photoId) candidates.add(id);
                });
            }
        }

        return candidates;
    }

    // Serialize for persistence (optional)
    serialize(): string {
        return JSON.stringify({
            config: this.config,
            hyperplanes: this.hyperplanes,
            hashTables: Array.from(this.hashTables).map(table =>
                Array.from(table.entries()).map(([k, v]) => [k, Array.from(v)])
            )
        });
    }

    static deserialize(data: string): LSHIndex {
        const parsed = JSON.parse(data);
        const lsh = new LSHIndex(parsed.config);
        lsh.hyperplanes = parsed.hyperplanes;
        lsh.hashTables = parsed.hashTables.map((table: any) =>
            new Map(table.map(([k, v]: [string, string[]]) => [k, new Set(v)]))
        );
        return lsh;
    }
}
```

#### 4.2: Implement LSH-Based Grouping

**File:** `chrome-extensions/src/lib/grouping.ts`

```typescript
import { LSHIndex } from './lsh';
import { cosineSimilarity } from './utils';
import type { Embedding } from './db';

export interface GroupingConfig {
    batchSize: number; // Photos per batch
    threshold: number; // Similarity threshold (0.85)
    timeWindowSeconds: number; // Time window for duplicates
    lshConfig: {
        numHashFunctions: 16;
        numHashTables: 4;
    };
    onProgress?: (completed: number, total: number) => void;
}

export class LSHPhotoGrouper {
    private lsh: LSHIndex;
    private groups: Map<string, Set<string>>;
    private photoToGroup: Map<string, string>;

    constructor(private config: GroupingConfig) {
        this.lsh = new LSHIndex({
            dimensions: 768,
            ...config.lshConfig,
            bucketThreshold: 100
        });
        this.groups = new Map();
        this.photoToGroup = new Map();
    }

    async groupPhotos(db: DatabaseService): Promise<void> {
        const totalEmbeddings = await db.getEmbeddingCount();
        let processed = 0;

        console.log(`Starting LSH grouping for ${totalEmbeddings} photos`);

        // Phase 1: Build LSH index (streaming)
        console.log('Phase 1: Building LSH index...');
        await db.forEachEmbeddingBatch(async (batch) => {
            for (const emb of batch) {
                this.lsh.addPhoto(emb.photoId, emb.embedding);
            }
            processed += batch.length;
            this.config.onProgress?.(processed, totalEmbeddings);
        }, this.config.batchSize);

        // Phase 2: Find similar photos within LSH buckets
        console.log('Phase 2: Finding similar photos...');
        processed = 0;

        await db.forEachEmbeddingBatch(async (batch) => {
            // Load metadata for time filtering
            const photoIds = batch.map(e => e.photoId);
            const photos = await db.getPhotosByIds(photoIds);
            const photoMap = new Map(photos.map(p => [p.id, p]));

            for (const emb of batch) {
                if (this.photoToGroup.has(emb.photoId)) {
                    continue; // Already grouped
                }

                const photo = photoMap.get(emb.photoId);
                if (!photo) continue;

                // Get candidates from LSH (O(log n))
                const candidates = this.lsh.getCandidates(
                    emb.photoId,
                    emb.embedding
                );

                // Check each candidate
                for (const candidateId of candidates) {
                    if (this.photoToGroup.has(candidateId)) {
                        continue; // Already grouped
                    }

                    // Time window filter (load minimal data)
                    const candidatePhoto = await db.getPhoto(candidateId);
                    const timeDiff = Math.abs(
                        photo.timestamp - candidatePhoto.timestamp
                    );

                    if (timeDiff > this.config.timeWindowSeconds * 1000) {
                        continue;
                    }

                    // Calculate similarity (only for candidates)
                    const candidateEmb = await db.getEmbedding(candidateId);
                    const similarity = cosineSimilarity(
                        emb.embedding,
                        candidateEmb.embedding
                    );

                    if (similarity >= this.config.threshold) {
                        this.addToGroup(emb.photoId, candidateId, similarity);
                    }
                }
            }

            processed += batch.length;
            this.config.onProgress?.(processed, totalEmbeddings);
        }, this.config.batchSize);

        // Phase 3: Save groups to IndexedDB
        console.log(`Phase 3: Saving ${this.groups.size} groups...`);
        await this.saveGroups(db);
    }

    private addToGroup(photoId1: string, photoId2: string, similarity: number): void {
        let groupId: string;

        if (this.photoToGroup.has(photoId1)) {
            groupId = this.photoToGroup.get(photoId1)!;
        } else if (this.photoToGroup.has(photoId2)) {
            groupId = this.photoToGroup.get(photoId2)!;
        } else {
            groupId = crypto.randomUUID();
            this.groups.set(groupId, new Set());
        }

        const group = this.groups.get(groupId)!;
        group.add(photoId1);
        group.add(photoId2);
        this.photoToGroup.set(photoId1, groupId);
        this.photoToGroup.set(photoId2, groupId);
    }

    private async saveGroups(db: DatabaseService): Promise<void> {
        // Clear existing groups
        await db.clearGroups(); // Optimized in Phase 2

        // Save new groups in batches
        const groupArray = Array.from(this.groups.entries()).map(
            ([id, photoIds], idx) => ({
                id,
                photoIds: Array.from(photoIds),
                similarityScore: 0.9, // TODO: Calculate avg
                timestamp: Date.now(),
                reviewStatus: 'pending' as const
            })
        );

        // Batch insert (500 at a time)
        for (let i = 0; i < groupArray.length; i += 500) {
            const batch = groupArray.slice(i, i + 500);
            await db.addGroupsBatch(batch);
        }

        // Update photo.groupId in batches
        await db.forEachPhotoBatch(async (photoBatch) => {
            const updates = photoBatch.map(photo => ({
                ...photo,
                groupId: this.photoToGroup.get(photo.id) || null
            }));
            await db.updatePhotosBatch(updates);
        }, 500);
    }
}
```

#### 4.3: Add Batch Operations to db.ts

```typescript
// Batch inserts
async addGroupsBatch(groups: Group[]): Promise<void> {
    const tx = this.db.transaction('groups', 'readwrite');
    const store = tx.objectStore('groups');
    for (const group of groups) {
        store.add(group);
    }
    await new Promise(resolve => tx.oncomplete = resolve);
}

async updatePhotosBatch(photos: Photo[]): Promise<void> {
    const tx = this.db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    for (const photo of photos) {
        store.put(photo);
    }
    await new Promise(resolve => tx.oncomplete = resolve);
}

// Batch fetch by IDs (optimized)
async getPhotosByIds(ids: string[]): Promise<Photo[]> {
    return new Promise((resolve, reject) => {
        const photos: Photo[] = [];
        const tx = this.db.transaction('photos', 'readonly');
        const store = tx.objectStore('photos');

        let completed = 0;
        for (const id of ids) {
            const request = store.get(id);
            request.onsuccess = () => {
                if (request.result) photos.push(request.result);
                completed++;
                if (completed === ids.length) resolve(photos);
            };
        }
    });
}
```

---

### Phase 5: Advanced Optimizations (Optional - 1 week)

**Goal:** Further scalability improvements for 1M+ images

#### 5.1: Compound Indexes

```typescript
// db.ts: Add during schema migration (v4)
photosStore.createIndex(
    'embeddingAndGroup',
    ['hasEmbedding', 'groupId'],
    { unique: false }
);

photosStore.createIndex(
    'timestampAndEmbedding',
    ['timestamp', 'hasEmbedding'],
    { unique: false }
);
```

#### 5.2: Web Workers for Processing

**New file:** `chrome-extensions/src/workers/grouping.worker.ts`

```typescript
// Offload grouping to worker thread
import { LSHPhotoGrouper } from '../lib/grouping';

self.onmessage = async (e) => {
    const { type, data } = e.data;

    if (type === 'START_GROUPING') {
        const grouper = new LSHPhotoGrouper(data.config);
        await grouper.groupPhotos(data.db);

        self.postMessage({ type: 'COMPLETE' });
    }
};
```

**Usage in App:**
```typescript
const worker = new Worker('/workers/grouping.worker.ts');
worker.postMessage({
    type: 'START_GROUPING',
    data: { config: groupingConfig }
});
```

#### 5.3: Progressive Image Loading

```typescript
// Load thumbnails first, full images on demand
interface PhotoMetadata {
    id: string;
    timestamp: number;
    dateTaken: string;
    fileName: string;
    hasEmbedding: boolean;
    groupId: string | null;
    // No blob - loaded separately
}

// Separate stores for metadata vs blobs
// photos: Full Photo objects
// photoMetadata: Lightweight metadata only
```

#### 5.4: IndexedDB Connection Pooling

```typescript
// Reuse connections instead of opening repeatedly
class DBConnectionPool {
    private connections: IDBDatabase[] = [];
    private readonly poolSize = 5;

    async getConnection(): Promise<IDBDatabase> {
        if (this.connections.length < this.poolSize) {
            return await this.openNewConnection();
        }
        return this.connections[0]; // Reuse
    }
}
```

---

## Part 3: Performance Targets & Validation

### Memory Targets

| Operation | Current (20K) | Target (100K) | Target (1M) |
|-----------|---------------|---------------|-------------|
| Initial Load | 40GB 💥 | 200MB ✅ | 200MB ✅ |
| Viewing Photos | 40GB 💥 | 200-500MB ✅ | 200-500MB ✅ |
| Grouping | 40GB 💥 | 500MB ✅ | 1GB ✅ |
| Reindexing | 40GB 💥 | 300MB ✅ | 500MB ✅ |

### Performance Targets

| Operation | Current (20K) | Target (20K) | Target (100K) | Target (1M) |
|-----------|---------------|--------------|---------------|-------------|
| Initial Page Load | 💥 Crash | <1s | <2s | <3s |
| Scroll Photos | N/A | 60fps | 60fps | 60fps |
| Grouping | 💥 Crash | 10s | 60s | 10min |
| Load Stats | 10s | <100ms | <100ms | <100ms |
| Delete Selected | 30s | 5s | 20s | 3min |

### Validation Checklist

**Phase 1 Validation:**
- [ ] `getPhotosBatch(0, 100)` completes in <100ms
- [ ] `getCachedStats()` returns in <10ms
- [ ] Memory usage stable at ~200MB after loading 100 photos
- [ ] `forEachPhotoBatch()` processes 10K photos without crash

**Phase 2 Validation:**
- [ ] App loads with 20K photos without crash
- [ ] `refreshData()` completes in <1s
- [ ] Virtual scrolling maintains 60fps
- [ ] Memory stays under 500MB during normal usage

**Phase 3 Validation:**
- [ ] Infinite scroll works smoothly with 100K photos
- [ ] Blob URLs properly released (check DevTools Memory)
- [ ] Old photos removed from memory after scrolling past

**Phase 4 Validation:**
- [ ] LSH grouping completes 20K photos in <15s
- [ ] LSH grouping completes 100K photos in <2min
- [ ] Grouping accuracy >95% (manual spot check)
- [ ] Memory during grouping <1GB

**Load Testing:**
```bash
# Generate test datasets
npm run generate-test-data -- --count 100000

# Run memory profiler
npm run test:memory

# Run performance benchmarks
npm run benchmark
```

---

## Part 4: Migration Strategy

### Backward Compatibility

**Critical:** Users have existing databases. Must migrate gracefully.

#### Migration Plan

**Step 1: Feature Flags**
```typescript
const FEATURE_FLAGS = {
    USE_BATCHED_READS: localStorage.getItem('feature_batched_reads') === 'true',
    USE_LSH_GROUPING: localStorage.getItem('feature_lsh_grouping') === 'true',
    USE_VIRTUAL_SCROLLING: localStorage.getItem('feature_virtual_scroll') === 'true'
};

// Gradual rollout
async function loadPhotos() {
    if (FEATURE_FLAGS.USE_BATCHED_READS) {
        return await db.getPhotosBatch(0, 100);
    } else {
        return await db.getAllPhotos(); // Legacy
    }
}
```

**Step 2: Schema Version Bump**
```typescript
// Bump to v4
const DB_VERSION = 4;

db.onupgradeneeded = (event) => {
    const db = event.target.result;
    const oldVersion = event.oldVersion;

    if (oldVersion < 4) {
        // Add compound indexes
        const photosStore = transaction.objectStore('photos');
        photosStore.createIndex('embeddingAndGroup', ['hasEmbedding', 'groupId']);

        // Populate metadata cache
        populateMetadataCache();
    }
};

async function populateMetadataCache() {
    const stats = {
        totalPhotos: await db.getPhotoCount(),
        totalEmbeddings: await db.getEmbeddingCount(),
        totalGroups: await db.getGroupCount(),
        lastUpdated: Date.now()
    };
    localStorage.setItem('lens_stats_cache', JSON.stringify(stats));
}
```

**Step 3: Gradual Rollout**
1. Release Phase 1 with feature flag OFF by default
2. Monitor error rates for 1 week
3. Enable for 10% of users
4. Ramp to 50%, then 100%
5. Remove legacy code after 1 month

---

## Part 5: Alternative Approaches Considered

### Alternative 1: OPFS (Origin Private File System)

**Pros:**
- Native browser file system, better for large files
- Faster than IndexedDB for blobs
- Direct streaming reads

**Cons:**
- Browser support limited (Chrome 86+, no Firefox)
- Requires complete refactor
- No structured queries (need custom indexing)

**Decision:** Stick with IndexedDB, optimize queries

---

### Alternative 2: Server-Side Processing

**Pros:**
- Unlimited memory on server
- Can use better algorithms (FAISS, Pinecone)
- No browser limitations

**Cons:**
- User privacy concerns (photos on server)
- Requires backend infrastructure
- Network latency

**Decision:** Keep client-side, optimize with LSH

---

### Alternative 3: WASM-based Vector Search

**Libraries:**
- `hnswlib-wasm`: HNSW algorithm (faster than LSH)
- `faiss-web`: Facebook's vector search

**Pros:**
- O(log n) query time
- Higher accuracy
- Battle-tested algorithms

**Cons:**
- Large WASM bundle (~5MB)
- More complex setup
- Overkill for current scale

**Decision:** Start with LSH, migrate to HNSW if needed

---

## Part 6: Risks & Mitigations

### Risk 1: Breaking Existing Installations

**Likelihood:** High
**Impact:** High

**Mitigation:**
- Feature flags for gradual rollout
- Keep legacy code paths
- Extensive testing with real user data
- Rollback plan

### Risk 2: LSH False Negatives

**Likelihood:** Medium
**Impact:** Medium

**Description:** LSH might miss some duplicates

**Mitigation:**
- Use multiple hash tables (4-8) for better recall
- Tune threshold and parameters
- Provide "re-group" button for users
- A/B test against current algorithm

### Risk 3: Virtual Scrolling Performance

**Likelihood:** Low
**Impact:** High

**Description:** Virtual scrolling with large images might lag

**Mitigation:**
- Lazy load images (IntersectionObserver)
- Use responsive images (thumbnail → full)
- Recycle DOM elements
- Test on low-end devices

### Risk 4: Migration Data Loss

**Likelihood:** Low
**Impact:** Critical

**Mitigation:**
- Schema migrations tested on copies
- No destructive operations during migration
- Export/import backup feature
- User data stays in IndexedDB (unchanged)

---

## Part 7: Success Metrics

### Key Performance Indicators (KPIs)

**Before Optimization (20K photos):**
- Memory: 40GB → Crash 💥
- Initial Load: N/A (crashes)
- Grouping: N/A (crashes)

**After Phase 1 (20K photos):**
- Memory: <300MB ✅
- Initial Load: <1s ✅
- Grouping: <15s ✅

**After Phase 4 (100K photos):**
- Memory: <500MB ✅
- Initial Load: <2s ✅
- Grouping: <2min ✅

**Stretch Goal (1M photos):**
- Memory: <1GB ✅
- Initial Load: <5s ✅
- Grouping: <15min ✅

### User Experience Metrics

- **Time to First Photo:** <500ms
- **Scroll Frame Rate:** 60fps
- **Perceived Performance:** Instant (cached metadata)
- **Crash Rate:** 0% (vs current 100% at 20K)

---

## Part 8: Implementation Timeline

### Week 1-2: Foundation (Phase 1)
- [ ] Day 1-2: Add batched read methods
- [ ] Day 3-4: Implement localStorage caching
- [ ] Day 5: Deprecate dangerous methods
- [ ] Day 6-7: Testing & validation

### Week 3-4: Core Refactoring (Phase 2)
- [ ] Day 1-3: Refactor appStore.ts
- [ ] Day 4-5: Refactor stats & reindexing
- [ ] Day 6-7: Testing with 20K dataset

### Week 5: UI Updates (Phase 3)
- [ ] Day 1-2: Implement virtual scrolling
- [ ] Day 3-4: Update PhotoGrid component
- [ ] Day 5: Testing & polish

### Week 6-7: LSH Grouping (Phase 4)
- [ ] Day 1-3: Implement LSH index
- [ ] Day 4-6: Implement LSH grouping
- [ ] Day 7: Tuning & optimization

### Week 8: Testing & Rollout
- [ ] Day 1-3: Load testing (100K, 1M photos)
- [ ] Day 4-5: Performance profiling
- [ ] Day 6: Feature flag rollout (10%)
- [ ] Day 7: Monitor & ramp to 100%

**Total Timeline: 8 weeks** (can parallelize for 6 weeks)

---

## Part 9: Code Review Checklist

Before approving each phase:

**Phase 1:**
- [ ] No `getAll()` calls in new code
- [ ] All batch methods have offset/limit
- [ ] localStorage cache invalidation works
- [ ] Memory profiling shows <500MB usage

**Phase 2:**
- [ ] All `getAllPhotos()` calls removed
- [ ] Stats use count() operations
- [ ] Reindexing uses batched updates
- [ ] Backward compatibility maintained

**Phase 3:**
- [ ] Virtual scrolling maintains 60fps
- [ ] Blob URLs properly revoked
- [ ] Infinite scroll works smoothly
- [ ] Works on low-end devices

**Phase 4:**
- [ ] LSH grouping faster than O(n²)
- [ ] Accuracy ≥95% vs baseline
- [ ] Memory during grouping <1GB
- [ ] Progress reporting works

---

## Appendix A: Technical References

### LSH Papers & Resources
- **Original Paper:** "Locality-Sensitive Hashing Scheme Based on p-Stable Distributions" (Datar et al., 2004)
- **Google's Usage:** Minhash for duplicate detection in web crawling
- **Practical Guide:** [LSH Tutorial by MIT](http://web.mit.edu/andoni/www/LSH/)

### Browser Limitations
- **IndexedDB Quota:** ~60% of free disk space per origin
- **Memory Limits:** ~2GB for 32-bit, ~4GB for 64-bit tabs
- **Blob Storage:** Stored off-heap, but URLs consume memory

### Performance Tools
- **Chrome DevTools:**
  - Memory Profiler → Heap Snapshots
  - Performance → Recording → Find memory leaks
  - Application → IndexedDB → Inspect stores

- **Lighthouse:**
  - Audit performance scores
  - Check Time to Interactive (TTI)

---

## Appendix B: Batch Size Recommendations

### Research-Based Optimal Sizes

**Photos (with Blobs):**
- Display: 50-100 (2-4MB per photo = 100-400MB)
- Processing: 100-200 (depends on operation)
- Maximum safe: 300 (600MB)

**Embeddings (vectors):**
- Display: N/A (not shown)
- Processing: 1000-5000 (3-15MB)
- Maximum safe: 10000 (30MB)

**Groups (metadata):**
- Display: 100 (UI pagination)
- Processing: 500-1000
- Maximum safe: No limit (small objects)

**Rule of Thumb:**
- Keep batch processing under 100MB
- Target 50-100 items per UI update
- Balance between progress granularity & overhead

---

## Appendix C: Testing Data Generation

```typescript
// Generate test datasets
async function generateTestData(count: number) {
    console.log(`Generating ${count} test photos...`);

    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;

    for (let i = 0; i < count; i++) {
        // Generate random image
        ctx.fillStyle = `hsl(${Math.random() * 360}, 70%, 50%)`;
        ctx.fillRect(0, 0, 1920, 1080);

        // Random text
        ctx.fillStyle = 'white';
        ctx.font = '48px Arial';
        ctx.fillText(`Test Photo ${i}`, 50, 100);

        // Convert to blob
        const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.8);
        });

        // Add to DB
        await db.addPhoto({
            id: `test-${i}`,
            blob,
            mediaType: 'image/jpeg',
            timestamp: Date.now() - (i * 1000),
            dateTaken: new Date().toISOString(),
            fileName: `test-${i}.jpg`,
            hasEmbedding: false,
            groupId: null
        });

        if (i % 100 === 0) {
            console.log(`Generated ${i}/${count}...`);
        }
    }
}
```

---

## Summary & Next Steps

### What This Plan Achieves

✅ **Scalability:** 1K → 1M photos without crashes
✅ **Performance:** Sub-second loads, smooth scrolling
✅ **Memory:** Constant ~200-500MB usage
✅ **Maintainability:** Clean, well-documented code
✅ **User Experience:** Instant perceived performance

### Critical Success Factors

1. **Phase 1 is non-negotiable** - Must eliminate `getAll()` calls
2. **Testing with real data** - Generate 100K+ test dataset
3. **Gradual rollout** - Feature flags prevent mass breakage
4. **Memory monitoring** - Continuous profiling during dev

### Approval Required For:

- [ ] Overall approach (LSH vs alternatives)
- [ ] Implementation phases & timeline
- [ ] Batch sizes & parameters
- [ ] localStorage schema
- [ ] Virtual scrolling library choice
- [ ] Migration strategy

---

**Ready for Review. Awaiting approval to proceed with Phase 1.**

---

## Questions for Product Owner

1. **Priority:** Which phase is most critical? (Recommend: Phase 1)
2. **Timeline:** Is 8-week timeline acceptable? Can we parallelize?
3. **Breaking Changes:** OK to require Chrome 86+ for best experience?
4. **Testing:** Can we get access to real user databases (anonymized)?
5. **Rollout:** Percentage-based rollout acceptable? (10% → 50% → 100%)
6. **Alternatives:** Should we investigate WASM HNSW in parallel?

---

End of plan. Ready for implementation upon approval.
