/**
 * Locality-Sensitive Hashing (LSH) for fast similarity search
 * Reduces photo grouping from O(n²) to O(n log n)
 *
 * Algorithm: Random Hyperplane LSH (SimHash variant)
 * - Hash similar embeddings to same buckets
 * - Only compare photos within same buckets
 * - Achieves ~100x speedup for large datasets
 */

export interface LSHConfig {
	dimensions: number; // Embedding dimension (768 for DINOv2)
	numHashFunctions: number; // 16-32 (higher = better precision)
	numHashTables: number; // 4-8 (higher = better recall)
}

/**
 * LSH Index for fast nearest neighbor search
 */
export class LSHIndex {
	private hyperplanes: number[][][]; // [table][function][dimension]
	private hashTables: Map<string, Set<string>>[]; // buckets per table
	private config: LSHConfig;

	constructor(config: Partial<LSHConfig> = {}) {
		this.config = {
			dimensions: config.dimensions || 768,
			numHashFunctions: config.numHashFunctions || 16,
			numHashTables: config.numHashTables || 4
		};

		this.hyperplanes = this.generateHyperplanes();
		this.hashTables = Array(this.config.numHashTables)
			.fill(null)
			.map(() => new Map());

		console.log('LSH Index initialized:', {
			dimensions: this.config.dimensions,
			hashFunctions: this.config.numHashFunctions,
			hashTables: this.config.numHashTables
		});
	}

	/**
	 * Generate random projection hyperplanes for hashing
	 * Uses Gaussian random vectors for better distribution
	 */
	private generateHyperplanes(): number[][][] {
		const tables: number[][][] = [];

		for (let t = 0; t < this.config.numHashTables; t++) {
			const table: number[][] = [];

			for (let f = 0; f < this.config.numHashFunctions; f++) {
				const plane: number[] = [];

				// Generate Gaussian random vector
				for (let d = 0; d < this.config.dimensions; d++) {
					plane.push(this.gaussianRandom());
				}

				// Normalize to unit vector
				const norm = Math.sqrt(plane.reduce((s, v) => s + v * v, 0));
				if (norm > 0) {
					table.push(plane.map(v => v / norm));
				} else {
					// Fallback to uniform random if norm is 0
					table.push(plane.map(() => Math.random() * 2 - 1));
				}
			}

			tables.push(table);
		}

		return tables;
	}

	/**
	 * Generate Gaussian random number using Box-Muller transform
	 */
	private gaussianRandom(): number {
		const u1 = Math.random();
		const u2 = Math.random();
		return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}

	/**
	 * Hash an embedding vector for a specific hash table
	 * Returns a binary string (e.g., "1001101...")
	 */
	private hashForTable(embedding: number[], tableIdx: number): string {
		const hyperplanes = this.hyperplanes[tableIdx];
		let hash = '';

		for (const plane of hyperplanes) {
			// Dot product with hyperplane
			const dotProduct = embedding.reduce(
				(sum, val, idx) => sum + val * plane[idx],
				0
			);

			// Hash bit: 1 if positive, 0 if negative
			hash += dotProduct >= 0 ? '1' : '0';
		}

		return hash;
	}

	/**
	 * Add a photo embedding to all hash tables
	 */
	addPhoto(photoId: string, embedding: number[]): void {
		if (embedding.length !== this.config.dimensions) {
			console.warn(
				`Embedding dimension mismatch: expected ${this.config.dimensions}, got ${embedding.length}`
			);
			return;
		}

		for (let t = 0; t < this.config.numHashTables; t++) {
			const hash = this.hashForTable(embedding, t);
			const table = this.hashTables[t];

			if (!table.has(hash)) {
				table.set(hash, new Set());
			}
			table.get(hash)!.add(photoId);
		}
	}

	/**
	 * Query for candidate duplicates/similar photos
	 * Returns union of all buckets across hash tables
	 */
	getCandidates(photoId: string, embedding: number[]): Set<string> {
		const candidates = new Set<string>();

		// Check all hash tables (union of results increases recall)
		for (let t = 0; t < this.config.numHashTables; t++) {
			const hash = this.hashForTable(embedding, t);
			const bucket = this.hashTables[t].get(hash);

			if (bucket) {
				bucket.forEach(id => {
					if (id !== photoId) {
						candidates.add(id);
					}
				});
			}
		}

		return candidates;
	}

	/**
	 * Get statistics about the LSH index
	 */
	getStats(): {
		totalPhotos: number;
		bucketsPerTable: number[];
		avgBucketSize: number[];
		maxBucketSize: number[];
	} {
		const totalPhotosSet = new Set<string>();
		const bucketsPerTable: number[] = [];
		const avgBucketSize: number[] = [];
		const maxBucketSize: number[] = [];

		for (let t = 0; t < this.config.numHashTables; t++) {
			const table = this.hashTables[t];
			bucketsPerTable.push(table.size);

			let totalSize = 0;
			let maxSize = 0;

			table.forEach(bucket => {
				bucket.forEach(photoId => totalPhotosSet.add(photoId));
				totalSize += bucket.size;
				maxSize = Math.max(maxSize, bucket.size);
			});

			avgBucketSize.push(table.size > 0 ? totalSize / table.size : 0);
			maxBucketSize.push(maxSize);
		}

		return {
			totalPhotos: totalPhotosSet.size,
			bucketsPerTable,
			avgBucketSize,
			maxBucketSize
		};
	}

	/**
	 * Estimate reduction in comparisons vs brute force
	 */
	estimateSpeedup(totalPhotos: number): {
		bruteForce: number;
		lsh: number;
		speedup: number;
	} {
		const stats = this.getStats();
		const avgBucketSize = stats.avgBucketSize.reduce((a, b) => a + b, 0) / stats.avgBucketSize.length;

		const bruteForceComparisons = (totalPhotos * (totalPhotos - 1)) / 2;
		const lshComparisons = totalPhotos * avgBucketSize * this.config.numHashTables;

		return {
			bruteForce: bruteForceComparisons,
			lsh: lshComparisons,
			speedup: bruteForceComparisons / Math.max(lshComparisons, 1)
		};
	}

	/**
	 * Clear the index
	 */
	clear(): void {
		this.hashTables.forEach(table => table.clear());
	}

	/**
	 * Serialize LSH index to JSON (for persistence)
	 */
	serialize(): string {
		return JSON.stringify({
			config: this.config,
			hyperplanes: this.hyperplanes,
			hashTables: this.hashTables.map(table =>
				Array.from(table.entries()).map(([k, v]) => [k, Array.from(v)])
			)
		});
	}

	/**
	 * Deserialize LSH index from JSON
	 */
	static deserialize(data: string): LSHIndex {
		const parsed = JSON.parse(data);
		const lsh = new LSHIndex(parsed.config);

		lsh.hyperplanes = parsed.hyperplanes;
		lsh.hashTables = parsed.hashTables.map((tableData: [string, string[]][]) =>
			new Map(tableData.map(([k, v]) => [k, new Set(v)]))
		);

		return lsh;
	}
}

/**
 * Helper function to calculate cosine similarity between two embeddings
 * This is used after LSH narrows down candidates
 */
export function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
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

	const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
	if (magnitude === 0) return 0;

	return dotProduct / magnitude;
}
