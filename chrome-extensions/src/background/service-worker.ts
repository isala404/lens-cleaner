/**
 * Background Service Worker for Lens Cleaner
 * Handles photo storage, embedding calculations, and grouping
 */

import db, { type Photo } from '../lib/db';
import { EmbeddingsProcessor } from '../lib/embeddings';
import { LSHPhotoGrouper } from '../lib/grouping';

// Import Transformers.js at the top level
// import { pipeline } from '@huggingface/transformers';

// Initialize processors
let embeddingsProcessor: EmbeddingsProcessor | null = null;

// State management
let isProcessingEmbeddings = false;
let processingProgress = {
	total: 0,
	processed: 0,
	status: 'idle' // idle, processing, completed, error
};

/**
 * Initialize the service worker
 */
async function initialize() {
	console.log('Lens Cleaner service worker starting...');

	try {
		// Initialize database
		await db.init();
		console.log('Database initialized');

		// Initialize embeddings processor
		embeddingsProcessor = new EmbeddingsProcessor();

		console.log('Service worker ready');
	} catch (error) {
		console.error('Failed to initialize service worker:', error);
	}
}

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
	console.log('Extension installed');
	initialize();
});

// Initialize on startup
initialize();

/**
 * Message handler
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log('Received message:', message.action);

	switch (message.action) {
		case 'storePhotos':
			handleStorePhotos(message.photos)
				.then((result) => sendResponse({ success: true, result }))
				.catch((error) => sendResponse({ success: false, error: error.message }));
			return true; // Keep channel open for async response

		case 'startEmbeddings':
			handleStartEmbeddings(message.options)
				.then((result) => sendResponse({ success: true, result }))
				.catch((error) => sendResponse({ success: false, error: error.message }));
			return true;

		case 'getEmbeddingProgress':
			sendResponse({
				success: true,
				progress: processingProgress
			});
			return false;

		case 'startGrouping':
			handleStartGrouping(message.options)
				.then((result) => sendResponse({ success: true, result }))
				.catch((error) => sendResponse({ success: false, error: error.message }));
			return true;

		case 'getStats':
			handleGetStats()
				.then((stats) => sendResponse({ success: true, stats }))
				.catch((error) => sendResponse({ success: false, error: error.message }));
			return true;

		case 'clearAllData':
			handleClearAllData()
				.then(() => sendResponse({ success: true }))
				.catch((error) => sendResponse({ success: false, error: error.message }));
			return true;

		case 'initiateScan':
			console.log('🟢 Received initiateScan for tab:', message.tabId);
			// Start the scan process asynchronously (don't wait for tab load)
			handleInitiateScan(message.tabId, message.options).catch((error) =>
				console.error('🔴 Error in handleInitiateScan:', error)
			);
			// Respond immediately so popup can close
			sendResponse({ success: true, message: 'Scan initiated' });
			return false; // Response sent synchronously

		case 'initiateDeletion':
			console.log('🗑️ Received initiateDeletion for tab:', message.tabId);
			// Start the deletion process asynchronously
			handleInitiateDeletion(message.tabId).catch((error) =>
				console.error('🔴 Error in handleInitiateDeletion:', error)
			);
			// Respond immediately
			sendResponse({ success: true, message: 'Deletion workflow initiated' });
			return false; // Response sent synchronously

		default:
			sendResponse({ success: false, error: 'Unknown action' });
			return false;
	}
});

/**
 * Store photos in IndexedDB
 * Reconstructs Blobs from ArrayBuffer data received from content script
 */
interface PhotoWithBlobData extends Omit<Photo, 'blob'> {
	blob: null;
	blobData: {
		arrayBuffer: number[];
		type: string;
		size: number;
	};
}

async function handleStorePhotos(photos: PhotoWithBlobData[]) {
	console.log(`Storing ${photos.length} photos...`);

	try {
		// Reconstruct Blobs from ArrayBuffer data
		const photosWithBlobs: Photo[] = photos.map((photo) => {
			if (photo.blobData) {
				// Reconstruct blob from ArrayBuffer data
				const uint8Array = new Uint8Array(photo.blobData.arrayBuffer);
				const blob = new Blob([uint8Array], { type: photo.blobData.type });
				return {
					...photo,
					blob: blob
				} as Photo;
			}
			// If blob already exists (shouldn't happen, but handle gracefully)
			return photo as unknown as Photo;
		});

		await db.addPhotos(photosWithBlobs);
		console.log(`Successfully stored ${photos.length} photos`);

		// Update metadata
		const stats = await db.getStats();
		await db.setMetadata('lastScrapeTime', Date.now());
		await db.setMetadata('totalPhotos', stats.totalPhotos);

		return {
			stored: photos.length,
			totalPhotos: stats.totalPhotos
		};
	} catch (error) {
		console.error('Error storing photos:', error);
		throw error;
	}
}

/**
 * Start embedding calculation process
 */
async function handleStartEmbeddings(options: { batchSize?: number } = {}) {
	if (isProcessingEmbeddings) {
		throw new Error('Embedding processing already in progress');
	}

	console.log('Starting embedding calculations...');

	isProcessingEmbeddings = true;
	processingProgress = {
		total: 0,
		processed: 0,
		status: 'processing'
	};

	try {
		// Get photos without embeddings
		const photos = await db.getPhotosWithoutEmbeddings(); // Process all
		processingProgress.total = photos.length;

		console.log(`Found ${photos.length} photos to process`);

		if (photos.length === 0) {
			processingProgress.status = 'completed';
			isProcessingEmbeddings = false;
			return {
				message: 'No photos need processing',
				processed: 0
			};
		}

		// Initialize embeddings processor if not already done
		if (!embeddingsProcessor) {
			embeddingsProcessor = new EmbeddingsProcessor();
		}

		if (!embeddingsProcessor.isInitialized()) {
			console.log('Initializing CLIP model (first time may take 1-2 minutes to download)...');
			await embeddingsProcessor.initialize();
			console.log('CLIP model ready!');
		}

		// Process photos in batches
		const batchSize = options.batchSize || 10;
		let processed = 0;

		for (let i = 0; i < photos.length; i += batchSize) {
			const batch = photos.slice(i, i + batchSize);

			for (const photo of batch) {
				try {
					// Convert blob to data URL for embedding calculation
					const dataUrl = await blobToDataUrl(photo.blob);
					// Remove data:image/...;base64, prefix to get just the base64 string
					const base64 = dataUrl.split(',')[1];

					// Calculate embedding
					const embedding = await embeddingsProcessor.calculateEmbedding(base64);

					// Store embedding
					await db.addEmbedding(photo.id, embedding);

					processed++;
					processingProgress.processed = processed;

					if (processed % 10 === 0) {
						console.log(`Processed ${processed}/${photos.length} embeddings`);
					}
				} catch (error) {
					console.error(`Error processing photo ${photo.id}:`, error);
					// Continue with next photo
				}
			}
		}

		processingProgress.status = 'completed';
		await db.setMetadata('lastEmbeddingTime', Date.now());

		console.log(`Embedding processing complete: ${processed} photos`);

		return {
			message: 'Embedding processing complete',
			processed: processed,
			total: photos.length
		};
	} catch (error) {
		console.error('Error during embedding processing:', error);
		processingProgress.status = 'error';
		throw error;
	} finally {
		isProcessingEmbeddings = false;
	}
}

/**
 * Start grouping process using LSH-based algorithm
 */
async function handleStartGrouping(
	options: { similarityThreshold?: number; timeWindowMinutes?: number } = {}
) {
	console.log('Starting photo grouping with LSH...');

	try {
		const {
			similarityThreshold = 0.6, // Same threshold as main.py
			timeWindowMinutes = 60
		} = options;

		// Check if there are photos with embeddings
		const embeddingCount = await db.getEmbeddingCount();

		console.log(`Grouping ${embeddingCount} photos with LSH algorithm`);

		if (embeddingCount === 0) {
			return {
				message: 'No photos with embeddings to group',
				groups: 0
			};
		}

		// Use LSH-based grouper (handles streaming internally)
		const grouper = new LSHPhotoGrouper({
			similarityThreshold,
			timeWindowMinutes,
			batchSize: 1000, // Process 1000 embeddings per batch
			lshConfig: {
				numHashFunctions: 16,
				numHashTables: 4
			}
		});

		// Groups are saved to database by grouper
		const photoGroups = await grouper.groupPhotos();

		await db.setMetadata('lastGroupingTime', Date.now());
		await db.setMetadata('totalGroups', photoGroups.length);

		console.log(`Found ${photoGroups.length} groups`);

		return {
			message: 'Grouping complete',
			groups: photoGroups.length,
			photosInGroups: photoGroups.reduce((sum, g) => sum + g.photoIds.length, 0)
		};
	} catch (error) {
		console.error('Error during grouping:', error);
		throw error;
	}
}

/**
 * Get database statistics
 */
async function handleGetStats() {
	const stats = await db.getStats();
	const lastScrapeTime = await db.getMetadata('lastScrapeTime');
	const lastEmbeddingTime = await db.getMetadata('lastEmbeddingTime');
	const lastGroupingTime = await db.getMetadata('lastGroupingTime');

	return {
		...stats,
		lastScrapeTime,
		lastEmbeddingTime,
		lastGroupingTime
	};
}

/**
 * Clear all data
 */
async function handleClearAllData() {
	console.log('Clearing all data...');
	await db.clearAll();
	processingProgress = {
		total: 0,
		processed: 0,
		status: 'idle'
	};
	console.log('All data cleared');
}

/**
 * Initiate scan on a tab
 * This waits for the tab to load then sends the scraping message
 */
async function handleInitiateScan(tabId: number, options: { maxScrolls?: number } = {}) {
	console.log('📸 Service worker initiating scan on tab:', tabId);

	return new Promise((resolve, reject) => {
		// Listen for tab updates
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
		const listener = (updatedTabId: number, changeInfo: any, _tab: chrome.tabs.Tab) => {
			if (updatedTabId === tabId && changeInfo.status === 'complete') {
				console.log('📸 Tab loaded, sending startScraping message...');

				// Remove listener
				chrome.tabs.onUpdated.removeListener(listener);

				// Wait a bit for content script to initialize
				setTimeout(async () => {
					try {
						await chrome.tabs.sendMessage(tabId, {
							action: 'startScraping',
							options: options
						});
						console.log('📸 Scraping message sent successfully');
						resolve(undefined);
					} catch (error) {
						console.error('📸 Error sending message to content script:', error);
						reject(error);
					}
				}, 2000);
			}
		};

		chrome.tabs.onUpdated.addListener(listener);

		// Timeout after 30 seconds
		setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener);
			reject(new Error('Timeout waiting for tab to load'));
		}, 30000);
	});
}

/**
 * Initiate deletion workflow on a tab
 * This opens Google Photos albums page and starts the deletion workflow
 * Fetches selected photo IDs from IndexedDB and sends them to content script in batches
 */
async function handleInitiateDeletion(tabId: number) {
	console.log('🗑️ Service worker initiating deletion workflow');

	try {
		// Get count of selected photos
		const selectedCount = await db.getSelectedPhotosCount();
		console.log(`🗑️ Found ${selectedCount} selected photos to delete`);

		if (selectedCount === 0) {
			console.log('🗑️ No photos selected, aborting deletion workflow');
			return;
		}

		// Update the tab to navigate to albums page
		await chrome.tabs.update(tabId, {
			url: 'https://photos.google.com/albums'
		});

		// Wait for the tab to load
		return new Promise((resolve, reject) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
			const listener = (updatedTabId: number, changeInfo: any, _tab: chrome.tabs.Tab) => {
				if (updatedTabId === tabId && changeInfo.status === 'complete') {
					console.log('🗑️ Albums page loaded, fetching selected photos from IndexedDB...');

					// Remove listener
					chrome.tabs.onUpdated.removeListener(listener);

					// Wait for content script to initialize, then fetch and send photo IDs
					setTimeout(async () => {
						try {
							// Fetch all selected photo IDs from IndexedDB
							// For now, we'll use getAllSelectedPhotos since we need to pass all IDs to content script
							// In the future, content script could query IndexedDB directly
							const photoIds = await db.getAllSelectedPhotos();

							console.log(`🗑️ Fetched ${photoIds.length} photo IDs from IndexedDB`);

							await chrome.tabs.sendMessage(tabId, {
								action: 'startDeletion',
								photoIds: photoIds
							});
							console.log('🗑️ Deletion message sent successfully');
							resolve(undefined);
						} catch (error) {
							console.error('🗑️ Error fetching photo IDs or sending message:', error);
							reject(error);
						}
					}, 2000);
				}
			};

			chrome.tabs.onUpdated.addListener(listener);

			// Timeout after 30 seconds
			setTimeout(() => {
				chrome.tabs.onUpdated.removeListener(listener);
				reject(new Error('Timeout waiting for albums page to load'));
			}, 30000);
		});
	} catch (error) {
		console.error('🗑️ Error in handleInitiateDeletion:', error);
		throw error;
	}
}

/**
 * Convert blob to data URL
 */
function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

console.log('Service worker loaded');
