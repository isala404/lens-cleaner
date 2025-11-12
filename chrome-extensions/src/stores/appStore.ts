/**
 * Application state store - STREAMING VERSION
 * Manages stats, processing state, and settings (NO photo/group arrays!)
 *
 * Key changes from original:
 * - Stores ONLY stats/counts, not photos/groups arrays
 * - Uses batched operations for all database access
 * - LSH-based grouping for O(n log n) performance
 */

import { writable, derived, get } from 'svelte/store';
import db, { type Photo, type Group, type Stats } from '../lib/db';
import { EmbeddingsProcessor } from '../lib/embeddings';
import { LSHPhotoGrouper } from '../lib/grouping';

// Settings interface
export interface Settings {
	similarityThreshold: number;
	timeWindowMinutes: number;
}

// Processing progress interface
export interface ProcessingProgress {
	isProcessing: boolean;
	type: 'embedding' | 'grouping' | null;
	current: number;
	total: number;
	message: string;
	phase?: 'building_index' | 'finding_duplicates' | 'saving_groups';
}

// Application state (METADATA ONLY - no photos/groups arrays!)
interface AppState {
	stats: Stats;
	selectedPhotosCount: number;
	settings: Settings;
	processingProgress: ProcessingProgress;
	viewMode: 'groups' | 'all';
	sortBy: 'similarity' | 'size' | 'date';
	minGroupSize: number;
}

// Initialize default state
const defaultState: AppState = {
	stats: {
		totalPhotos: 0,
		photosWithEmbeddings: 0,
		totalGroups: 0,
		photosInGroups: 0,
		ungroupedWithEmbeddings: 0,
		selectedPhotos: 0,
		lastUpdated: Date.now()
	},
	selectedPhotosCount: 0,
	settings: {
		similarityThreshold: 0.406, // Default to 40.6% (70% in UI)
		timeWindowMinutes: 60
	},
	processingProgress: {
		isProcessing: false,
		type: null,
		current: 0,
		total: 0,
		message: ''
	},
	viewMode: 'groups',
	sortBy: 'similarity',
	minGroupSize: 2
};

// Create the main store
export const appStore = writable<AppState>(defaultState);

// Singleton instances
let embeddingsProcessor: EmbeddingsProcessor | null = null;

// Persist processing state
function saveProcessingState(progress: ProcessingProgress, originalTotal?: number) {
	if (progress.isProcessing) {
		localStorage.setItem(
			'lensCleanerProcessingState',
			JSON.stringify({
				type: progress.type,
				current: progress.current,
				total: progress.total,
				originalTotal: originalTotal || progress.total,
				message: progress.message,
				timestamp: Date.now()
			})
		);
	} else {
		localStorage.removeItem('lensCleanerProcessingState');
	}
}

// Restore processing state
function getSavedProcessingState(): (ProcessingProgress & { originalTotal?: number }) | null {
	try {
		const saved = localStorage.getItem('lensCleanerProcessingState');
		if (!saved) return null;

		const state = JSON.parse(saved);
		// Check if state is recent (within last hour)
		const age = Date.now() - state.timestamp;
		if (age > 3600000) {
			localStorage.removeItem('lensCleanerProcessingState');
			return null;
		}

		return {
			isProcessing: true,
			type: state.type,
			current: state.current,
			total: state.total,
			originalTotal: state.originalTotal,
			message: state.message || ''
		};
	} catch {
		return null;
	}
}

// Initialize database
export async function initializeApp() {
	try {
		await db.init();
		console.log('Database initialized');
		await refreshData();

		// Load settings from localStorage
		const savedSettings = localStorage.getItem('lensCleanerSettings');
		if (savedSettings) {
			const settings = JSON.parse(savedSettings);
			appStore.update((state) => ({ ...state, settings }));
		}

		// Update selection count from IndexedDB
		const selectedCount = await db.getSelectedPhotosCount();
		appStore.update((state) => ({ ...state, selectedPhotosCount: selectedCount }));

		// Auto-select photos with AI suggestions
		await autoSelectAISuggestedPhotos();

		// Check for interrupted processing
		const savedProgress = getSavedProcessingState();
		if (savedProgress) {
			// Check if there's still work to do
			const stats = await db.getStats();
			const photosWithoutEmbeddings = await db.getPhotosWithoutEmbeddings(1);

			if (savedProgress.type === 'embedding' && photosWithoutEmbeddings.length > 0) {
				appStore.update((s) => ({
					...s,
					processingProgress: savedProgress
				}));
				console.log('Resuming interrupted embedding process...');
			} else if (savedProgress.type === 'grouping' && stats.photosWithEmbeddings > 0) {
				appStore.update((s) => ({
					...s,
					processingProgress: savedProgress
				}));
				console.log('Resuming interrupted grouping process...');
			} else {
				localStorage.removeItem('lensCleanerProcessingState');
			}
		}
	} catch (error) {
		console.error('Failed to initialize app:', error);
		throw error;
	}
}

// Refresh all data from database (STATS ONLY - no arrays!)
export async function refreshData() {
	try {
		// Only load stats, not photos/groups arrays
		const stats = await db.getStats();
		const selectedCount = await db.getSelectedPhotosCount();

		appStore.update((state) => ({
			...state,
			stats,
			selectedPhotosCount: selectedCount
		}));

		console.log('Data refreshed:', stats);
	} catch (error) {
		console.error('Error refreshing data:', error);
		throw error;
	}
}

// Calculate embeddings
export async function calculateEmbeddings() {
	const savedProgress = getSavedProcessingState();

	const isResuming = savedProgress?.type === 'embedding' && savedProgress.isProcessing;
	const originalTotal = savedProgress?.originalTotal;
	const alreadyProcessed = savedProgress?.current || 0;

	appStore.update((s) => ({
		...s,
		processingProgress: {
			isProcessing: true,
			type: 'embedding',
			current: alreadyProcessed,
			total: originalTotal || 0,
			message: isResuming ? 'Resuming analysis...' : 'Initializing AI model...'
		}
	}));
	saveProcessingState(
		{
			isProcessing: true,
			type: 'embedding',
			current: alreadyProcessed,
			total: originalTotal || 0,
			message: 'Initializing AI model...'
		},
		originalTotal
	);

	try {
		// Initialize processor if needed
		if (!embeddingsProcessor) {
			embeddingsProcessor = new EmbeddingsProcessor();
		}

		if (!embeddingsProcessor.isInitialized()) {
			await embeddingsProcessor.initialize();
		}

		// Get photos without embeddings
		const photos = await db.getPhotosWithoutEmbeddings();

		const totalToShow = originalTotal || photos.length;
		const currentProcessed = isResuming ? alreadyProcessed : 0;

		const remainingAtStart = totalToShow - currentProcessed;
		appStore.update((s) => ({
			...s,
			processingProgress: {
				...s.processingProgress,
				total: totalToShow,
				current: currentProcessed,
				message: isResuming
					? `Resuming: ${remainingAtStart} photo${remainingAtStart !== 1 ? 's' : ''} left...`
					: `${remainingAtStart} photo${remainingAtStart !== 1 ? 's' : ''} left...`
			}
		}));
		saveProcessingState(
			{
				isProcessing: true,
				type: 'embedding',
				current: currentProcessed,
				total: totalToShow,
				message: `${remainingAtStart} photo${remainingAtStart !== 1 ? 's' : ''} left...`
			},
			totalToShow
		);

		if (photos.length === 0) {
			appStore.update((s) => ({
				...s,
				processingProgress: {
					isProcessing: false,
					type: null,
					current: 0,
					total: 0,
					message: ''
				}
			}));
			localStorage.removeItem('lensCleanerProcessingState');
			return alreadyProcessed;
		}

		// Process all remaining photos
		let processed = currentProcessed;
		for (const photo of photos) {
			try {
				const dataUrl = await blobToDataUrl(photo.blob);
				const base64 = dataUrl.split(',')[1];

				const embedding = await embeddingsProcessor.calculateEmbedding(base64);
				await db.addEmbedding(photo.id, embedding);
				processed++;

				const remaining = totalToShow - processed;
				appStore.update((s) => ({
					...s,
					processingProgress: {
						...s.processingProgress,
						current: processed,
						message: `${remaining} photo${remaining !== 1 ? 's' : ''} left...`
					}
				}));
				saveProcessingState(
					{
						isProcessing: true,
						type: 'embedding',
						current: processed,
						total: totalToShow,
						message: `${remaining} photo${remaining !== 1 ? 's' : ''} left...`
					},
					totalToShow
				);
			} catch (error) {
				console.error(`Error processing photo ${photo.id}:`, error);
			}
		}

		await db.setMetadata('lastEmbeddingTime', Date.now());
		await refreshData();

		appStore.update((s) => ({
			...s,
			processingProgress: {
				isProcessing: false,
				type: null,
				current: 0,
				total: 0,
				message: ''
			}
		}));
		localStorage.removeItem('lensCleanerProcessingState');

		return processed;
	} catch (error) {
		console.error('Error calculating embeddings:', error);
		appStore.update((s) => ({
			...s,
			processingProgress: {
				isProcessing: false,
				type: null,
				current: 0,
				total: 0,
				message: ''
			}
		}));
		localStorage.removeItem('lensCleanerProcessingState');
		throw error;
	}
}

// Group photos using LSH
export async function groupPhotos() {
	const state = get(appStore);
	const savedProgress = getSavedProcessingState();
	const isResuming = savedProgress?.type === 'grouping' && savedProgress.isProcessing;
	const alreadyProcessed = savedProgress?.current || 0;
	const originalTotal = savedProgress?.originalTotal;

	appStore.update((s) => ({
		...s,
		processingProgress: {
			isProcessing: true,
			type: 'grouping',
			current: alreadyProcessed,
			total: originalTotal || 0,
			message: isResuming ? 'Resuming grouping...' : 'Preparing to group photos...'
		}
	}));
	saveProcessingState(
		{
			isProcessing: true,
			type: 'grouping',
			current: alreadyProcessed,
			total: originalTotal || 0,
			message: isResuming ? 'Resuming grouping...' : 'Preparing to group photos...'
		},
		originalTotal
	);

	try {
		// Use LSH-based grouper (O(n log n) instead of O(n²))
		const grouper = new LSHPhotoGrouper({
			similarityThreshold: state.settings.similarityThreshold,
			timeWindowMinutes: state.settings.timeWindowMinutes,
			batchSize: 1000, // Process 1000 embeddings per batch
			lshConfig: {
				numHashFunctions: 16,
				numHashTables: 4
			},
			onProgress: async (progress) => {
				const message = progress.phase === 'building_index'
					? progress.message
					: progress.phase === 'finding_duplicates'
					? `Found ${progress.groupsFound} groups • Processed ${progress.photosProcessed}/${progress.totalPhotos} photos`
					: `Saving ${progress.groupsFound} groups to database...`;

				appStore.update((s) => ({
					...s,
					processingProgress: {
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message,
						phase: progress.phase
					}
				}));

				saveProcessingState(
					{
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message,
						phase: progress.phase
					},
					originalTotal || progress.totalPhotos
				);
			}
		});

		// Groups are saved to database by grouper
		const groups = await grouper.groupPhotos();

		await db.setMetadata('lastGroupingTime', Date.now());
		await db.setMetadata('totalGroups', groups.length);
		await refreshData();

		appStore.update((s) => ({
			...s,
			processingProgress: {
				isProcessing: false,
				type: null,
				current: 0,
				total: 0,
				message: ''
			}
		}));
		localStorage.removeItem('lensCleanerProcessingState');

		return groups.length;
	} catch (error) {
		console.error('Error grouping photos:', error);
		appStore.update((s) => ({
			...s,
			processingProgress: {
				isProcessing: false,
				type: null,
				current: 0,
				total: 0,
				message: ''
			}
		}));
		localStorage.removeItem('lensCleanerProcessingState');
		throw error;
	}
}

// Clear all data
export async function clearAllData() {
	try {
		await db.clearAll();
		localStorage.removeItem('lensCleanerProcessingState');
		appStore.update((s) => ({
			...s,
			stats: {
				totalPhotos: 0,
				photosWithEmbeddings: 0,
				totalGroups: 0,
				photosInGroups: 0,
				ungroupedWithEmbeddings: 0,
				selectedPhotos: 0,
				lastUpdated: Date.now()
			},
			selectedPhotosCount: 0,
			processingProgress: {
				isProcessing: false,
				type: null,
				current: 0,
				total: 0,
				message: ''
			}
		}));
	} catch (error) {
		console.error('Error clearing data:', error);
		throw error;
	}
}

// Delete selected photos from local database
export async function deleteSelectedPhotos() {
	// Get photo IDs from IndexedDB in batches
	const photoIds = await db.getAllSelectedPhotos();

	if (photoIds.length === 0) {
		return;
	}

	try {
		await db.deletePhotos(photoIds);
		await db.clearSelectedPhotos();
		appStore.update((s) => ({
			...s,
			selectedPhotosCount: 0
		}));
		await refreshData();
	} catch (error) {
		console.error('Error deleting photos:', error);
		throw error;
	}
}

// Delete selected photos from Google Photos
export async function deleteFromGooglePhotos() {
	const selectedCount = await db.getSelectedPhotosCount();

	if (selectedCount === 0) {
		return;
	}

	try {
		const tab = await chrome.tabs.create({
			url: 'https://photos.google.com/albums',
			active: true
		});

		if (tab.id) {
			await chrome.runtime.sendMessage({
				action: 'initiateDeletion',
				tabId: tab.id
			});
		}
	} catch (error) {
		console.error('Error initiating Google Photos deletion:', error);
		throw error;
	}
}

// Delete a group
export async function deleteGroup(groupId: string) {
	try {
		await db.deleteGroup(groupId);
		await refreshData();
	} catch (error) {
		console.error('Error deleting group:', error);
		throw error;
	}
}

// Check if a photo is selected
export async function isPhotoSelected(photoId: string): Promise<boolean> {
	return await db.isPhotoSelected(photoId);
}

// Auto-select photos with AI suggestions (streams in batches)
async function autoSelectAISuggestedPhotos() {
	let foundAnyAI = false;

	await db.forEachPhotoBatch(async (batch) => {
		const aiSuggestedPhotos = batch.filter(p => p.aiSuggestionReason);

		if (aiSuggestedPhotos.length > 0) {
			foundAnyAI = true;
			for (const photo of aiSuggestedPhotos) {
				await db.selectPhoto(photo.id);
			}
		}
	}, 500);

	if (foundAnyAI) {
		const selectedCount = await db.getSelectedPhotosCount();
		appStore.update((state) => ({ ...state, selectedPhotosCount: selectedCount }));
		console.log('Auto-selected AI-suggested photos');
	}
}

// Toggle photo selection
export async function togglePhotoSelection(photoId: string) {
	const isSelected = await db.isPhotoSelected(photoId);

	if (isSelected) {
		await db.unselectPhoto(photoId);
	} else {
		await db.selectPhoto(photoId);
	}

	const selectedCount = await db.getSelectedPhotosCount();
	appStore.update((state) => ({ ...state, selectedPhotosCount: selectedCount }));
}

// Select all photos in a group
export async function selectAllInGroup(groupId: string) {
	const group = await db.getGroup(groupId);
	if (!group) return;

	for (const photoId of group.photoIds) {
		await db.selectPhoto(photoId);
	}

	const selectedCount = await db.getSelectedPhotosCount();
	appStore.update((state) => ({ ...state, selectedPhotosCount: selectedCount }));
}

// Clear selection
export async function clearSelection() {
	await db.clearSelectedPhotos();
	appStore.update((state) => ({
		...state,
		selectedPhotosCount: 0
	}));
}

// Update settings
export function updateSettings(settings: Partial<Settings>) {
	appStore.update((state) => {
		const newSettings = { ...state.settings, ...settings };
		localStorage.setItem('lensCleanerSettings', JSON.stringify(newSettings));
		return { ...state, settings: newSettings };
	});
}

// Update view mode
export function setViewMode(mode: 'groups' | 'all') {
	appStore.update((state) => ({ ...state, viewMode: mode }));
}

// Update sort by
export function setSortBy(sortBy: 'similarity' | 'size' | 'date') {
	appStore.update((state) => ({ ...state, sortBy }));
}

// Update min group size
export function setMinGroupSize(size: number) {
	appStore.update((state) => ({ ...state, minGroupSize: size }));
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

// Derived store for filtered groups
// NOTE: This loads ALL groups. For large datasets, UI components should
// use db.getGroupsBatch() directly instead of this derived store
export const filteredGroups = derived(appStore, ($appStore) => {
	// Return empty array by default
	// UI components should load groups themselves using db.getGroupsBatch()
	return [];
});
