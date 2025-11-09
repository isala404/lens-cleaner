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
    similarityThreshold: 0.85,
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
      appStore.update(state => ({ ...state, settings }));
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

    appStore.update(state => ({
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
  appStore.update(s => ({
    ...s,
    processingProgress: {
      isProcessing: true,
      type: 'embedding',
      current: 0,
      total: 0,
      message: 'Initializing AI model...'
    }
  }));

  try {
    // Initialize processor if needed
    if (!embeddingsProcessor) {
      embeddingsProcessor = new EmbeddingsProcessor();
    }

    if (!embeddingsProcessor.isInitialized()) {
      await embeddingsProcessor.initialize();
    }

    // Get photos without embeddings
    const photos = await db.getPhotosWithoutEmbeddings(10000);

    appStore.update(s => ({
      ...s,
      processingProgress: {
        ...s.processingProgress,
        total: photos.length,
        message: `Processing ${photos.length} photos...`
      }
    }));

    if (photos.length === 0) {
      appStore.update(s => ({
        ...s,
        processingProgress: {
          isProcessing: false,
          type: null,
          current: 0,
          total: 0,
          message: ''
        }
      }));
      return 0;
    }

    // Process photos
    let processed = 0;
    for (const photo of photos) {
      try {
        const embedding = await embeddingsProcessor.calculateEmbedding(photo.base64);
        await db.addEmbedding(photo.id, embedding);
        processed++;

        appStore.update(s => ({
          ...s,
          processingProgress: {
            ...s.processingProgress,
            current: processed,
            message: `Processed ${processed}/${photos.length} photos...`
          }
        }));
      } catch (error) {
        console.error(`Error processing photo ${photo.id}:`, error);
      }
    }

    await db.setMetadata('lastEmbeddingTime', Date.now());
    await refreshData();

    appStore.update(s => ({
      ...s,
      processingProgress: {
        isProcessing: false,
        type: null,
        current: 0,
        total: 0,
        message: ''
      }
    }));

    return processed;
  } catch (error) {
    console.error('Error calculating embeddings:', error);
    appStore.update(s => ({
      ...s,
      processingProgress: {
        isProcessing: false,
        type: null,
        current: 0,
        total: 0,
        message: ''
      }
    }));
    throw error;
  }
}

// Group photos
export async function groupPhotos() {
  const state = get(appStore);

  appStore.update(s => ({
    ...s,
    processingProgress: {
      isProcessing: true,
      type: 'grouping',
      current: 0,
      total: 0,
      message: 'Grouping similar photos...'
    }
  }));

  try {
    // Initialize processor if needed
    if (!groupingProcessor) {
      groupingProcessor = new GroupingProcessor();
    }

    // Get all photos with embeddings
    const photos = await db.getAllPhotos();
    const photosWithEmbeddings = photos.filter(p => p.hasEmbedding);

    if (photosWithEmbeddings.length === 0) {
      appStore.update(s => ({
        ...s,
        processingProgress: {
          isProcessing: false,
          type: null,
          current: 0,
          total: 0,
          message: ''
        }
      }));
      return 0;
    }

    // Get all embeddings
    const embeddings = await db.getAllEmbeddings();
    const embeddingMap = new Map(embeddings.map(e => [e.photoId, e.embedding]));

    // Group photos
    const groups = await groupingProcessor.groupSimilarPhotos(
      photosWithEmbeddings,
      embeddingMap,
      state.settings.similarityThreshold,
      state.settings.timeWindowMinutes
    );

    // Store groups in database
    for (const group of groups) {
      await db.createGroup(group.photoIds, group.avgSimilarity);
    }

    await db.setMetadata('lastGroupingTime', Date.now());
    await db.setMetadata('totalGroups', groups.length);
    await refreshData();

    appStore.update(s => ({
      ...s,
      processingProgress: {
        isProcessing: false,
        type: null,
        current: 0,
        total: 0,
        message: ''
      }
    }));

    return groups.length;
  } catch (error) {
    console.error('Error grouping photos:', error);
    appStore.update(s => ({
      ...s,
      processingProgress: {
        isProcessing: false,
        type: null,
        current: 0,
        total: 0,
        message: ''
      }
    }));
    throw error;
  }
}

// Clear all data
export async function clearAllData() {
  try {
    await db.clearAll();
    appStore.update(s => ({
      ...s,
      photos: [],
      groups: [],
      selectedPhotos: new Set(),
      stats: {
        totalPhotos: 0,
        photosWithEmbeddings: 0,
        totalGroups: 0,
        photosInGroups: 0
      }
    }));
  } catch (error) {
    console.error('Error clearing data:', error);
    throw error;
  }
}

// Delete selected photos
export async function deleteSelectedPhotos() {
  const state = get(appStore);
  const photoIds = Array.from(state.selectedPhotos);

  if (photoIds.length === 0) {
    return;
  }

  try {
    await db.deletePhotos(photoIds);
    appStore.update(s => ({
      ...s,
      selectedPhotos: new Set()
    }));
    await refreshData();
  } catch (error) {
    console.error('Error deleting photos:', error);
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
  appStore.update(state => {
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
  appStore.update(state => {
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return state;

    const newSelected = new Set(state.selectedPhotos);
    group.photoIds.forEach(id => newSelected.add(id));
    return { ...state, selectedPhotos: newSelected };
  });
}

// Clear selection
export function clearSelection() {
  appStore.update(state => ({
    ...state,
    selectedPhotos: new Set()
  }));
}

// Update settings
export function updateSettings(settings: Partial<Settings>) {
  appStore.update(state => {
    const newSettings = { ...state.settings, ...settings };
    localStorage.setItem('lensCleanerSettings', JSON.stringify(newSettings));
    return { ...state, settings: newSettings };
  });
}

// Update view mode
export function setViewMode(mode: 'groups' | 'all') {
  appStore.update(state => ({ ...state, viewMode: mode }));
}

// Update sort by
export function setSortBy(sortBy: 'similarity' | 'size' | 'date') {
  appStore.update(state => ({ ...state, sortBy }));
}

// Update min group size
export function setMinGroupSize(size: number) {
  appStore.update(state => ({ ...state, minGroupSize: size }));
}

// Derived stores
export const filteredGroups = derived(
  appStore,
  $appStore => {
    let filtered = $appStore.groups.filter(
      g => g.photoIds.length >= $appStore.minGroupSize
    );

    // Sort groups
    filtered.sort((a, b) => {
      switch ($appStore.sortBy) {
        case 'similarity':
          return (b.similarityScore || 0) - (a.similarityScore || 0);
        case 'size':
          return b.photoIds.length - a.photoIds.length;
        case 'date':
          return b.timestamp - a.timestamp;
        default:
          return 0;
      }
    });

    return filtered;
  }
);
