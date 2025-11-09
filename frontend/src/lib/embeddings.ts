/**
 * Embeddings processor
 * Calculates image embeddings using Transformers.js CLIP model
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

// Configure transformers.js environment for Chrome extension
// This is crucial to prevent CSP violations
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  // Running in Chrome extension context
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.proxy = false;

  // Set custom WASM paths to use extension's local files
  // This prevents loading from CDN which violates CSP
  const extensionURL = chrome.runtime.getURL('/');
  env.backends.onnx.wasm.wasmPaths = extensionURL;

  console.log('Transformers.js configured for Chrome extension');
  console.log('WASM paths set to:', extensionURL);
}

// Global feature extractor instance
let featureExtractor: FeatureExtractionPipeline | null = null;

export class EmbeddingsProcessor {
  private initialized = false;

  /**
   * Initialize the CLIP model
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('Initializing CLIP model...');

    try {
      // Create the feature extraction pipeline if not already created
      if (!featureExtractor) {
        console.log('Loading CLIP model (first time may take 1-2 minutes)...');

        featureExtractor = await pipeline(
          'image-feature-extraction',
          'Xenova/dinov2-base',
          {device: 'webgpu'}
        ) as FeatureExtractionPipeline;

        console.log('CLIP model loaded successfully');
      }

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize CLIP model:', error);
      throw error;
    }
  }

  /**
   * Check if processor is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Calculate embedding for a base64 image
   * @param base64Image - Base64 encoded image (without data:image prefix)
   * @param photoId - Optional photo ID for tracking
   * @returns Image embedding vector
   */
  async calculateEmbedding(base64Image: string, photoId?: string): Promise<Float32Array> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!featureExtractor) {
      throw new Error('Feature extractor not initialized');
    }

    try {
      // Convert base64 to data URL if not already
      let imageUrl = base64Image;
      if (!base64Image.startsWith('data:')) {
        imageUrl = `data:image/jpeg;base64,${base64Image}`;
      }

      // Extract features using CLIP
      const output = await featureExtractor(imageUrl);

      // The output is a Tensor with shape [1, 512]
      // Extract the data as Float32Array
      let embedding: Float32Array;

      if (output.data) {
        embedding = output.data as Float32Array;
      } else if ('tolist' in output && typeof output.tolist === 'function') {
        // Some versions return a tensor with tolist method
        const list = output.tolist();
        embedding = new Float32Array(list[0]);
      } else {
        // Fallback: try to access the data directly
        embedding = new Float32Array(output as any);
      }

      // Ensure it's a Float32Array
      if (!(embedding instanceof Float32Array)) {
        embedding = new Float32Array(embedding);
      }

      // CRITICAL: Normalize the embedding for cosine similarity
      // Without normalization, cosine similarity will return huge values
      const normalized = this.normalizeEmbedding(embedding);

      return normalized;
    } catch (error) {
      console.error('Error calculating embedding:', error);
      throw error;
    }
  }

  /**
   * Normalize an embedding vector (L2 normalization)
   */
  normalizeEmbedding(embedding: Float32Array | number[]): Float32Array {
    const array = Array.from(embedding);

    // Calculate L2 norm
    const norm = Math.sqrt(
      array.reduce((sum, val) => sum + val * val, 0)
    );

    // Normalize
    if (norm === 0) {
      return new Float32Array(array.length);
    }

    return new Float32Array(array.map(val => val / norm));
  }

  /**
   * Calculate cosine similarity between two embeddings
   * Since embeddings are normalized, this is just the dot product
   * @returns Similarity score between -1 and 1 (higher is more similar)
   */
  static cosineSimilarity(embedding1: Float32Array | number[], embedding2: Float32Array | number[]): number {
    const arr1 = Array.isArray(embedding1) ? embedding1 : Array.from(embedding1);
    const arr2 = Array.isArray(embedding2) ? embedding2 : Array.from(embedding2);

    if (arr1.length !== arr2.length) {
      throw new Error('Embeddings must have the same length');
    }

    let dotProduct = 0;
    for (let i = 0; i < arr1.length; i++) {
      dotProduct += arr1[i] * arr2[i];
    }

    return dotProduct;
  }

  /**
   * Batch calculate embeddings for multiple images
   * @param base64Images - Array of base64 encoded images
   * @param progressCallback - Optional callback for progress updates
   * @returns Array of embedding vectors
   */
  async calculateEmbeddingsBatch(
    base64Images: string[],
    progressCallback?: (current: number, total: number) => void
  ): Promise<Float32Array[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const embeddings: Float32Array[] = [];

    for (let i = 0; i < base64Images.length; i++) {
      const embedding = await this.calculateEmbedding(base64Images[i]);
      embeddings.push(embedding);

      if (progressCallback) {
        progressCallback(i + 1, base64Images.length);
      }
    }

    return embeddings;
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    // No cleanup needed for direct execution
    this.initialized = false;
    console.log('Embeddings processor disposed');
  }
}

/**
 * Utility function to calculate similarity between two base64 images
 * Useful for quick comparisons without storing embeddings
 */
export async function calculateImageSimilarity(base64Image1: string, base64Image2: string): Promise<number> {
  const processor = new EmbeddingsProcessor();
  await processor.initialize();

  const embedding1 = await processor.calculateEmbedding(base64Image1);
  const embedding2 = await processor.calculateEmbedding(base64Image2);

  const similarity = EmbeddingsProcessor.cosineSimilarity(embedding1, embedding2);

  return similarity;
}

export default EmbeddingsProcessor;
