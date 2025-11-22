/**
 * Application state store
 * Manages photos, groups, processing state, and settings
 */

import { writable, derived, get } from 'svelte/store';
import db, { type Photo, type Group, type Stats } from '../lib/db';
import { EmbeddingsProcessor } from '../lib/embeddings';
import { clusterImagesWithOverlap, type GroupingProgress } from '../lib/grouping';

// Settings interface
export interface Settings {
	similarityThreshold: number;
	timeWindowMinutes: number;
	windowSizeMinutes: number;
	overlapMinutes: number;
}

// Processing progress interface
export interface ProcessingProgress {
	isProcessing: boolean;
	type: 'embedding' | 'grouping' | null;
	current: number;
	total: number;
	message: string;
}

// Application state
interface AppState {
	photos: Photo[];
	groups: Group[];
	stats: Stats;
	selectedPhotosCount: number; // Now just a count, actual IDs stored in IndexedDB
	settings: Settings;
	processingProgress: ProcessingProgress;
	viewMode: 'groups' | 'all';
	sortBy: 'similarity' | 'size' | 'date';
	minGroupSize: number;
}

// Initialize default state
const defaultState: AppState = {
	photos: [],
	groups: [],
	stats: {
		totalPhotos: 0,
		photosWithEmbeddings: 0,
		totalGroups: 0,
		photosInGroups: 0
	},
	selectedPhotosCount: 0,
	settings: {
		similarityThreshold: 0.406, // Default to 40.6% (70% in UI)
		timeWindowMinutes: 60, // Default to 1 hour
		windowSizeMinutes: 60, // Default to 1 hour windows
		overlapMinutes: 30 // Default to 30 minute overlap
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
// Remove groupingProcessor since we're using the new function

// Persist processing state
function saveProcessingState(progress: ProcessingProgress, originalTotal?: number) {
	if (progress.isProcessing) {
		localStorage.setItem(
			'topPicsProcessingState',
			JSON.stringify({
				type: progress.type,
				current: progress.current,
				total: progress.total,
				originalTotal: originalTotal || progress.total, // Save original total for accurate progress
				message: progress.message,
				timestamp: Date.now()
			})
		);
	} else {
		localStorage.removeItem('topPicsProcessingState');
	}
}

// Restore processing state
function getSavedProcessingState(): (ProcessingProgress & { originalTotal?: number }) | null {
	try {
		const saved = localStorage.getItem('topPicsProcessingState');
		if (!saved) return null;

		const state = JSON.parse(saved);
		// Check if state is recent (within last hour) to avoid stale resumes
		const age = Date.now() - state.timestamp;
		if (age > 3600000) {
			// 1 hour
			localStorage.removeItem('topPicsProcessingState');
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

		// Load settings from IndexedDB (migrated from localStorage)
		const savedSettings = (await db.getMetadata('settings')) as Settings | undefined;
		if (savedSettings) {
			appStore.update((state) => ({ ...state, settings: savedSettings }));
		} else {
			// Migrate from localStorage if exists
			const localStorageSettings = localStorage.getItem('topPicsSettings');
			if (localStorageSettings) {
				const settings = JSON.parse(localStorageSettings);
				await db.setMetadata('settings', settings);
				appStore.update((state) => ({ ...state, settings }));
				// Clean up old localStorage
				localStorage.removeItem('topPicsSettings');
			}
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
				// Resume embedding processing
				appStore.update((s) => ({
					...s,
					processingProgress: savedProgress
				}));
				console.log('Resuming interrupted embedding process...');
			} else if (savedProgress.type === 'grouping' && stats.photosWithEmbeddings > 0) {
				// Resume grouping (even if groups exist, we'll clear them before resuming)
				appStore.update((s) => ({
					...s,
					processingProgress: savedProgress
				}));
				console.log('Resuming interrupted grouping process...');
			} else {
				// No work to resume, clear saved state
				localStorage.removeItem('topPicsProcessingState');
			}
		}
	} catch (error) {
		console.error('Failed to initialize app:', error);
		throw error;
	}
}

// Refresh all data from database
export async function refreshData() {
	try {
		const stats = await db.getStats(); // Now uses counters - fast!

		// Don't load all groups - UI will paginate them
		// Load only first batch for preview (optional - can be empty)
		const groups = await db.getGroupsBatch(0, 50);

		// Don't load all photos - UI will paginate
		const photos: Photo[] = [];

		// Update selection count from IndexedDB
		const selectedCount = await db.getSelectedPhotosCount();

		// Check if there are AI-suggested photos and auto-select them
		// Note: We need to check this differently since we don't load all photos
		// We'll handle this during photo pagination or in a separate method
		// For now, just update the state
		appStore.update((state) => ({
			...state,
			stats,
			groups,
			photos, // Empty - UI loads on demand
			selectedPhotosCount: selectedCount
		}));
	} catch (error) {
		console.error('Error refreshing data:', error);
		throw error;
	}
}

// Calculate embeddings
export async function calculateEmbeddings() {
	const savedProgress = getSavedProcessingState();

	// Check if we're resuming
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

		// Get photos without embeddings (these are the remaining photos to process)
		const photos = await db.getPhotosWithoutEmbeddings();

		// If resuming, use original total; otherwise use current count
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
			localStorage.removeItem('topPicsProcessingState');
			return alreadyProcessed;
		}

		// Process all remaining photos (starting from 0 in the filtered list)
		let processed = currentProcessed;
		for (const photo of photos) {
			try {
				// Convert blob to data URL for embedding calculation
				const dataUrl = await blobToDataUrl(photo.blob);
				// Remove data:image/...;base64, prefix to get just the base64 string
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
		localStorage.removeItem('topPicsProcessingState');

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
		localStorage.removeItem('topPicsProcessingState');
		throw error;
	}
}

// Group photos
export async function groupPhotos() {
	const state = get(appStore);
	// Note: Sliding window algorithm doesn't support resumability yet
	// Always start fresh to avoid conflicts
	const savedProgress = getSavedProcessingState();

	// Clear any existing saved state to start fresh
	if (savedProgress?.type === 'grouping') {
		localStorage.removeItem('topPicsProcessingState');
	}

	appStore.update((s) => ({
		...s,
		processingProgress: {
			isProcessing: true,
			type: 'grouping',
			current: 0,
			total: 0,
			message: 'Preparing to group photos...'
		}
	}));

	try {
		// No need to initialize processor anymore - using new sliding window method

		// Get all photos with embeddings (already sorted by dateTaken from database)
		const photos = await db.getAllPhotos();
		const photosWithEmbeddings = photos.filter((p) => p.hasEmbedding);

		if (photosWithEmbeddings.length === 0) {
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
			localStorage.removeItem('topPicsProcessingState');
			return 0;
		}

		// Clear existing groups to ensure clean start
		const stats = await db.getStats();
		if (stats.totalGroups > 0) {
			console.log('Clearing existing groups before starting...');
			await db.clearGroups();
			// Don't call refreshData() here - it would overwrite our real-time progress
			// We'll update stats directly in progress callback
		}

		// Update total count
		appStore.update((s) => ({
			...s,
			processingProgress: {
				...s.processingProgress,
				total: photosWithEmbeddings.length,
				current: 0,
				message: ''
			}
		}));
		saveProcessingState(
			{
				isProcessing: true,
				type: 'grouping',
				current: 0,
				total: photosWithEmbeddings.length,
				message: ''
			},
			photosWithEmbeddings.length
		);

		// Note: New sliding window method handles embeddings internally

		// Group photos using new memory-efficient sliding window method
		const groups = await clusterImagesWithOverlap(
			state.settings.similarityThreshold,
			state.settings.windowSizeMinutes,
			state.settings.overlapMinutes,
			state.settings.timeWindowMinutes,
			db,
			async (progress: GroupingProgress) => {
				// Save groups incrementally as they're found (for resumability)
				// Note: The algorithm returns all groups at the end, but we save progress
				// so if interrupted, we can restart cleanly
				const remainingPhotos = progress.totalPhotos - progress.photosProcessed;
				appStore.update((s) => ({
					...s,
					processingProgress: {
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message: `${remainingPhotos} photo${remainingPhotos !== 1 ? 's' : ''} left...`
					},
					stats: {
						...s.stats,
						totalGroups: progress.groupsFound // Update groups count in real-time
					}
				}));

				saveProcessingState(
					{
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message: ''
					},
					photosWithEmbeddings.length
				);
			}
		);

		// Store groups in database (all at once at the end)
		// If resuming, we already cleared existing groups above
		for (const group of groups) {
			await db.createGroup(group.photoIds, group.avgSimilarity);
		}

		await db.setMetadata('lastGroupingTime', Date.now());
		// Note: groups:count counter is automatically updated by createGroup()
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
		localStorage.removeItem('topPicsProcessingState');

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
		localStorage.removeItem('topPicsProcessingState');
		throw error;
	}
}

// Clear all data
export async function clearAllData() {
	try {
		await db.clearAll();
		localStorage.removeItem('topPicsProcessingState');
		appStore.update((s) => ({
			...s,
			photos: [],
			groups: [],
			selectedPhotosCount: 0,
			stats: {
				totalPhotos: 0,
				photosWithEmbeddings: 0,
				totalGroups: 0,
				photosInGroups: 0
			},
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
		// Create a new tab with Google Photos albums page
		const tab = await chrome.tabs.create({
			url: 'https://photos.google.com/albums',
			active: true
		});

		// Wait for tab to be created
		if (tab.id) {
			// Send message to service worker to initiate deletion workflow
			// NOTE: We don't pass photoIds anymore - service worker will fetch them from IndexedDB
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

// Check if a photo is selected (helper for UI components)
export async function isPhotoSelected(photoId: string): Promise<boolean> {
	return await db.isPhotoSelected(photoId);
}

// Auto-select photos with AI suggestions
// Note: This loads all photos, but only during initialization after auto-select completion
// For large datasets, we could optimize by adding a metadata flag to skip this check
async function autoSelectAISuggestedPhotos() {
	// Check if there are any AI suggestions via metadata first
	const hasAISuggestions = (await db.getMetadata('hasAISuggestions')) as boolean | undefined;
	if (hasAISuggestions === false) {
		return; // Skip if we know there are no AI suggestions
	}

	const photos = await db.getAllPhotos();
	const aiSuggestedPhotos = photos.filter((p) => p.aiSuggestionReason);

	if (aiSuggestedPhotos.length > 0) {
		for (const photo of aiSuggestedPhotos) {
			await db.selectPhoto(photo.id);
		}
		const selectedCount = await db.getSelectedPhotosCount();
		appStore.update((state) => ({ ...state, selectedPhotosCount: selectedCount }));
		console.log(`Auto-selected ${aiSuggestedPhotos.length} AI-suggested photos`);
		await db.setMetadata('hasAISuggestions', true);
	} else {
		await db.setMetadata('hasAISuggestions', false);
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
	const state = get(appStore);
	const group = state.groups.find((g) => g.id === groupId);
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
export async function updateSettings(settings: Partial<Settings>) {
	const state = get(appStore);
	const newSettings = { ...state.settings, ...settings };
	await db.setMetadata('settings', newSettings);
	appStore.update((state) => ({ ...state, settings: newSettings }));
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

// Derived stores
export const filteredGroups = derived(appStore, ($appStore) => {
	const filtered = $appStore.groups.filter((g) => g.photoIds.length >= $appStore.minGroupSize);

	return filtered;
});
