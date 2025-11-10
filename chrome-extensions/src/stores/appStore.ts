/**
 * Application state store
 * Manages photos, groups, processing state, and settings
 */

import { writable, derived, get } from 'svelte/store';
import db, { type Photo, type Group, type Stats } from '../lib/db';
import { EmbeddingsProcessor } from '../lib/embeddings';
import { GroupingProcessor } from '../lib/grouping';

// Settings interface
export interface Settings {
	similarityThreshold: number;
	timeWindowMinutes: number;
	maxPhotos: number;
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
	selectedPhotos: Set<string>;
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
	selectedPhotos: new Set(),
	settings: {
		similarityThreshold: 0.406, // Default to 40.6% (70% in UI)
		timeWindowMinutes: 60,
		maxPhotos: 1000
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
let groupingProcessor: GroupingProcessor | null = null;

// Persist processing state
function saveProcessingState(progress: ProcessingProgress, originalTotal?: number) {
	if (progress.isProcessing) {
		localStorage.setItem(
			'lensCleanerProcessingState',
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
		localStorage.removeItem('lensCleanerProcessingState');
	}
}

// Restore processing state
function getSavedProcessingState(): (ProcessingProgress & { originalTotal?: number }) | null {
	try {
		const saved = localStorage.getItem('lensCleanerProcessingState');
		if (!saved) return null;

		const state = JSON.parse(saved);
		// Check if state is recent (within last hour) to avoid stale resumes
		const age = Date.now() - state.timestamp;
		if (age > 3600000) {
			// 1 hour
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
				localStorage.removeItem('lensCleanerProcessingState');
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
		const stats = await db.getStats();
		const groups = await db.getAllGroups();
		const photos = await db.getAllPhotos();

		appStore.update((state) => ({
			...state,
			stats,
			groups,
			photos
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
		const photos = await db.getPhotosWithoutEmbeddings(10000);

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
			localStorage.removeItem('lensCleanerProcessingState');
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

// Group photos
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
		// Initialize processor if needed
		if (!groupingProcessor) {
			groupingProcessor = new GroupingProcessor();
		}

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
			localStorage.removeItem('lensCleanerProcessingState');
			return 0;
		}

		// If resuming and groups exist, clear them first to avoid duplicates
		// (This happens if grouping was interrupted after some groups were saved)
		if (isResuming) {
			const stats = await db.getStats();
			if (stats.totalGroups > 0) {
				console.log('Clearing existing groups before resuming...');
				await db.clearGroups();
				await refreshData();
			}
		}

		// Use original total if resuming, otherwise use current count
		const totalToShow = originalTotal || photosWithEmbeddings.length;
		const currentProcessed = isResuming ? alreadyProcessed : 0;

		// Update total count
		appStore.update((s) => ({
			...s,
			processingProgress: {
				...s.processingProgress,
				total: totalToShow,
				current: currentProcessed,
				message: isResuming
					? `Resuming: ${totalToShow - currentProcessed} photos remaining...`
					: `Starting to group ${photosWithEmbeddings.length} photos...`
			}
		}));
		saveProcessingState(
			{
				isProcessing: true,
				type: 'grouping',
				current: currentProcessed,
				total: totalToShow,
				message: isResuming
					? `Resuming: ${totalToShow - currentProcessed} photos remaining...`
					: `Starting to group ${photosWithEmbeddings.length} photos...`
			},
			totalToShow
		);

		// Get all embeddings
		const embeddings = await db.getAllEmbeddings();
		const embeddingMap = new Map(embeddings.map((e) => [e.photoId, e.embedding]));

		// Group photos with progress callback
		const groups = await groupingProcessor.groupSimilarPhotosBatched(
			photosWithEmbeddings,
			embeddingMap,
			state.settings.similarityThreshold,
			state.settings.timeWindowMinutes,
			async (progress) => {
				// Save groups incrementally as they're found (for resumability)
				// Note: The algorithm returns all groups at the end, but we save progress
				// so if interrupted, we can restart cleanly
				const message = `Processed ${progress.photosProcessed}/${progress.totalPhotos} photos • Found ${progress.groupsFound} groups`;

				appStore.update((s) => ({
					...s,
					processingProgress: {
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message: message
					}
				}));

				saveProcessingState(
					{
						isProcessing: true,
						type: 'grouping',
						current: progress.photosProcessed,
						total: progress.totalPhotos,
						message: message
					},
					totalToShow
				);
			},
			50 // batch size
		);

		// Store groups in database (all at once at the end)
		// If resuming, we already cleared existing groups above
		for (const group of groups) {
			await db.createGroup(group.photoIds, group.avgSimilarity);
		}

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
			photos: [],
			groups: [],
			selectedPhotos: new Set(),
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
	const state = get(appStore);
	const photoIds = Array.from(state.selectedPhotos);

	if (photoIds.length === 0) {
		return;
	}

	try {
		await db.deletePhotos(photoIds);
		appStore.update((s) => ({
			...s,
			selectedPhotos: new Set()
		}));
		await refreshData();
	} catch (error) {
		console.error('Error deleting photos:', error);
		throw error;
	}
}

// Delete selected photos from Google Photos
export async function deleteFromGooglePhotos() {
	const state = get(appStore);
	const photoIds = Array.from(state.selectedPhotos);

	if (photoIds.length === 0) {
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
			await chrome.runtime.sendMessage({
				action: 'initiateDeletion',
				tabId: tab.id,
				photoIds: photoIds
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

// Toggle photo selection
export function togglePhotoSelection(photoId: string) {
	appStore.update((state) => {
		const newSelected = new Set(state.selectedPhotos);
		if (newSelected.has(photoId)) {
			newSelected.delete(photoId);
		} else {
			newSelected.add(photoId);
		}
		return { ...state, selectedPhotos: newSelected };
	});
}

// Select all photos in a group
export function selectAllInGroup(groupId: string) {
	appStore.update((state) => {
		const group = state.groups.find((g) => g.id === groupId);
		if (!group) return state;

		const newSelected = new Set(state.selectedPhotos);
		group.photoIds.forEach((id) => newSelected.add(id));
		return { ...state, selectedPhotos: newSelected };
	});
}

// Clear selection
export function clearSelection() {
	appStore.update((state) => ({
		...state,
		selectedPhotos: new Set()
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

// Derived stores
export const filteredGroups = derived(appStore, ($appStore) => {
	const filtered = $appStore.groups.filter((g) => g.photoIds.length >= $appStore.minGroupSize);

	return filtered;
});
