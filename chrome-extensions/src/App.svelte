<script lang="ts">
	import './app.css';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	import {
		appStore,
		filteredGroups,
		initializeApp,
		refreshData,
		calculateEmbeddings,
		groupPhotos,
		clearAllData,
		deleteFromGooglePhotos,
		togglePhotoSelection,
		selectAllInGroup,
		clearSelection,
		updateSettings
	} from './stores/appStore';

	import db, { type Group, type Photo } from './lib/db';

	let currentStep: 'welcome' | 'preview' | 'indexing' | 'indexed' | 'grouping' | 'reviewing' =
		'welcome';

	let autoProcessing = false;
	let showSettings = false;
	let processingStartTime = 0;
	let processingStartProgress = 0; // Track progress at start for accurate time estimates
	let estimatedTimeRemaining = 0;

	// Settings - reactive to appStore
	$: settings = {
		similarityThreshold: $appStore.settings.similarityThreshold,
		timeWindowMinutes: $appStore.settings.timeWindowMinutes,
		minGroupSize: $appStore.minGroupSize
	};

	// Local settings for editing (before save)
	let editingSettings = {
		similarityThreshold: 0.45, // Default to 45% (85% in UI)
		timeWindowMinutes: 60,
		minGroupSize: 2
	};

	// Slider position for similarity threshold (0-100 in UI)
	// Maps to backend threshold (0.2-0.7)
	// UI 85% → Backend 45% (0.45)
	let similaritySliderPosition = 70; // Default to 70%

	// Convert backend threshold (0.2-0.7) to UI slider position (0-100)
	function thresholdToSliderPosition(threshold: number): number {
		// Map 0.2-0.45 to 0-85% slider position
		if (threshold <= 0.45) {
			return ((threshold - 0.2) / (0.45 - 0.2)) * 85;
		}

		// Map 0.45-0.7 to 85-100% slider position
		return 85 + ((threshold - 0.45) / (0.7 - 0.45)) * 15;
	}

	// Convert UI slider position (0-100) to backend threshold (0.2-0.7)
	function sliderPositionToThreshold(position: number): number {
		// Map 0-85% slider to 0.2-0.45 threshold
		if (position <= 85) {
			return 0.2 + (position / 85) * (0.45 - 0.2);
		}

		// Map 85-100% slider to 0.45-0.7 threshold
		return 0.45 + ((position - 85) / 15) * (0.7 - 0.45);
	}

	// Cache for group photos to avoid re-fetching
	let groupPhotosCache = new SvelteMap<string, Photo[]>();
	let ungroupedPhotos: Photo[] = [];

	// Sorted photos for preview screen (most recent first)
	$: sortedPhotos = [...$appStore.photos].sort((a, b) => {
		const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
		const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;

		return dateB - dateA; // Most recent first
	});

	onMount(async () => {
		await initializeApp();
		// Initialize editing settings from appStore
		editingSettings.similarityThreshold = $appStore.settings.similarityThreshold;
		editingSettings.timeWindowMinutes = $appStore.settings.timeWindowMinutes;
		editingSettings.minGroupSize = $appStore.minGroupSize;
		// Initialize slider position from threshold
		similaritySliderPosition = thresholdToSliderPosition(editingSettings.similarityThreshold);

		// Check if we need to resume interrupted processing
		if ($appStore.processingProgress.isProcessing) {
			if ($appStore.processingProgress.type === 'embedding') {
				currentStep = 'indexing';
				autoProcessing = true;
				processingStartTime = Date.now();
				processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from

				// Auto-resume embedding processing
				try {
					await calculateEmbeddings();
					await refreshData();
					determineCurrentStep();
				} catch (error) {
					console.error('Resume error:', error);
					autoProcessing = false;
					determineCurrentStep();
				}
			} else if ($appStore.processingProgress.type === 'grouping') {
				currentStep = 'grouping';
				autoProcessing = true;
				processingStartTime = Date.now();
				processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from

				// Auto-resume grouping
				try {
					await handleStartGrouping();
					determineCurrentStep();
				} catch (error) {
					console.error('Resume error:', error);
					autoProcessing = false;
					determineCurrentStep();
				}
			}
		} else {
			determineCurrentStep();
		}
	});

	function determineCurrentStep() {
		const stats = $appStore.stats;

		if (stats.totalPhotos === 0) {
			currentStep = 'welcome';
		} else if (stats.photosWithEmbeddings === 0) {
			currentStep = 'preview';
		} else if (stats.totalGroups === 0) {
			// All photos have embeddings but no groups yet - show indexed screen
			currentStep = 'indexed';
		} else {
			currentStep = 'reviewing';
			loadUngroupedPhotos();
		}
	}

	async function handleStartIndexing() {
		if (autoProcessing) return;
		autoProcessing = true;
		processingStartTime = Date.now();
		processingStartProgress = 0; // Start from 0 for new indexing
		currentStep = 'indexing';

		try {
			await calculateEmbeddings();
			await refreshData();
			determineCurrentStep();
		} catch (error) {
			console.error('Indexing error:', error);
			autoProcessing = false;
			determineCurrentStep();
		} finally {
			autoProcessing = false;
		}
	}

	async function handleStartGrouping() {
		if (!autoProcessing) {
			autoProcessing = true;
			processingStartTime = Date.now();
			processingStartProgress = 0; // Start from 0 for new grouping
		}

		currentStep = 'grouping';

		try {
			await groupPhotos();
			await refreshData();
			// Clear cache when new groups are created
			groupPhotosCache.clear();
			currentStep = 'reviewing';
			await loadUngroupedPhotos();
		} catch (error) {
			console.error('Grouping error:', error);
		} finally {
			autoProcessing = false;
		}
	}

	function handleClearSelection() {
		if ($appStore.selectedPhotos.size === 0) {
			return;
		}

		if (confirm(`Clear selection of ${$appStore.selectedPhotos.size} photo(s)?`)) {
			clearSelection();
		}
	}

	async function handleDeleteFromGooglePhotos() {
		if ($appStore.selectedPhotos.size === 0) {
			return;
		}

		if (
			confirm(
				`Create an album with ${$appStore.selectedPhotos.size} photo(s) in Google Photos for deletion?\n\nThis will:\n1. Open a new tab to Google Photos Albums\n2. Create an album with selected photos\n3. You can then review and delete them from the album`
			)
		) {
			try {
				await deleteFromGooglePhotos();
			} catch (error) {
				alert('Error initiating Google Photos deletion: ' + error);
			}
		}
	}

	async function handleReindex() {
		if (
			confirm(
				'This will clear all groups and embeddings. You will need to index again. Your scanned photos will be kept. Continue?'
			)
		) {
			try {
				// Clear groups and embeddings, keep photos
				await db.clearGroups();
				await db.clearEmbeddings();
				groupPhotosCache.clear();
				ungroupedPhotos = [];
				await refreshData();
				currentStep = 'preview';
			} catch (error) {
				alert('Error reindexing: ' + error);
			}
		}
	}

	async function handleRegroup() {
		if (
			confirm(
				'This will clear all duplicate groups. You can adjust settings and regroup. Your indexed photos will be kept. Continue?'
			)
		) {
			try {
				// Only clear groups, keep embeddings
				await db.clearGroups();
				groupPhotosCache.clear();
				ungroupedPhotos = [];
				await refreshData();
				currentStep = 'indexed';
			} catch (error) {
				alert('Error regrouping: ' + error);
			}
		}
	}

	async function handleRescan() {
		if (
			confirm(
				'⚠️ WARNING: This will delete all scanned photos and groups. You will need to scan from Google Photos again. Continue?'
			)
		) {
			try {
				await clearAllData();
				groupPhotosCache.clear();
				ungroupedPhotos = [];
				await refreshData();
				currentStep = 'welcome';
			} catch (error) {
				alert('Error clearing data: ' + error);
			}
		}
	}

	function handleSaveSettings() {
		updateSettings({
			similarityThreshold: editingSettings.similarityThreshold,
			timeWindowMinutes: editingSettings.timeWindowMinutes
		});

		// Update minGroupSize separately as it's not part of Settings interface
		appStore.update((s) => ({
			...s,
			minGroupSize: editingSettings.minGroupSize
		}));

		showSettings = false;
	}

	function handleOpenSettings() {
		// Load current settings into editing settings when opening modal
		editingSettings.similarityThreshold = $appStore.settings.similarityThreshold;
		editingSettings.timeWindowMinutes = $appStore.settings.timeWindowMinutes;
		editingSettings.minGroupSize = $appStore.minGroupSize;
		// Initialize slider position from threshold
		similaritySliderPosition = thresholdToSliderPosition(editingSettings.similarityThreshold);
		showSettings = true;
	}

	// Update threshold when slider position changes
	$: if (showSettings) {
		editingSettings.similarityThreshold = sliderPositionToThreshold(similaritySliderPosition);
	}

	async function getGroupPhotos(group: Group): Promise<Photo[]> {
		// Check cache first
		if (groupPhotosCache.has(group.id)) {
			return groupPhotosCache.get(group.id)!;
		}

		const photos = await Promise.all(group.photoIds.map((id) => db.getPhoto(id)));
		const validPhotos = photos.filter((p) => p !== undefined) as Photo[];

		// Sort photos by dateTaken (most recent first)
		validPhotos.sort((a, b) => {
			const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
			const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;

			return dateB - dateA; // Most recent first
		});

		// Cache the result
		groupPhotosCache.set(group.id, validPhotos);
		return validPhotos;
	}

	async function loadUngroupedPhotos() {
		try {
			const allPhotos = await db.getAllPhotos();
			const allGroups = await db.getAllGroups();
			// Get all photo IDs that are in groups
			const groupedPhotoIds = new SvelteSet<string>();

			allGroups.forEach((group) => {
				group.photoIds.forEach((id) => groupedPhotoIds.add(id));
			});

			// Filter photos that are NOT in any group
			ungroupedPhotos = allPhotos.filter((photo) => !groupedPhotoIds.has(photo.id));

			// Sort ungrouped photos by dateTaken (most recent first)
			ungroupedPhotos.sort((a, b) => {
				const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
				const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;

				return dateB - dateA; // Most recent first
			});
		} catch (error) {
			console.error('Error loading ungrouped photos:', error);
			ungroupedPhotos = [];
		}
	}

	// Update time estimate
	$: if ($appStore.processingProgress.isProcessing && processingStartTime > 0) {
		const elapsed = Date.now() - processingStartTime;
		const current = $appStore.processingProgress.current;
		const total = $appStore.processingProgress.total;
		const progressMade = current - processingStartProgress; // Only count new progress

		// Only calculate estimate if we've made progress since starting/resuming
		if (progressMade > 0 && total > 0 && elapsed > 0) {
			const rate = progressMade / elapsed; // items per ms (based on new progress only)
			const remaining = total - current;

			estimatedTimeRemaining = remaining / rate; // ms
		} else {
			estimatedTimeRemaining = 0; // Don't show estimate until we have progress
		}
	}

	function formatTimeEstimate(ms: number): string {
		const totalSeconds = Math.ceil(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		if (minutes === 0) {
			return `${seconds} seconds`;
		} else if (minutes < 60) {
			return `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;
		} else {
			const hours = Math.floor(minutes / 60);
			const remainingMinutes = minutes % 60;

			return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
		}
	}

	// Filter groups by minimum size
	$: displayGroups = $filteredGroups.filter((g) => g.photoIds.length >= settings.minGroupSize);
</script>

<div class="max-w-7xl mx-auto px-5 py-8">
	<!-- Header -->
	<header class="flex justify-center items-center mb-12">
		<div class="text-center flex-1">
			<h1 class="text-6xl font-black text-black mb-3 tracking-tight">📸 Lens Cleaner</h1>
			<p class="text-xl text-brutalist-gray font-semibold">Find and delete duplicate photos</p>
		</div>
	</header>

	<!-- Progress Steps -->
	<div class="flex items-center justify-center mb-14 px-5">
		<div class="flex flex-col items-center gap-2">
			<div
				class="w-16 h-16 rounded-full flex items-center justify-center font-black text-2xl border-4 border-black transition-all duration-300"
				class:bg-pastel-pink-200={currentStep === 'welcome' || currentStep === 'preview'}
				class:shadow-brutalist-sm={currentStep === 'welcome' || currentStep === 'preview'}
				class:bg-emerald-400={currentStep === 'indexing' ||
					currentStep === 'indexed' ||
					currentStep === 'grouping' ||
					currentStep === 'reviewing'}
				class:text-white={currentStep === 'indexing' ||
					currentStep === 'indexed' ||
					currentStep === 'grouping' ||
					currentStep === 'reviewing'}
				class:bg-gray-200={currentStep !== 'welcome' &&
					currentStep !== 'preview' &&
					currentStep !== 'indexing' &&
					currentStep !== 'indexed' &&
					currentStep !== 'grouping' &&
					currentStep !== 'reviewing'}
			>
				1
			</div>
			<div
				class="text-sm font-bold"
				class:text-black={currentStep === 'welcome' || currentStep === 'preview'}
				class:text-gray-500={currentStep !== 'welcome' && currentStep !== 'preview'}
			>
				Scan Photos
			</div>
		</div>
		<div
			class="w-20 h-1 mx-1 transition-all duration-300"
			class:bg-emerald-400={currentStep === 'indexing' ||
				currentStep === 'indexed' ||
				currentStep === 'grouping' ||
				currentStep === 'reviewing'}
			class:bg-gray-300={currentStep === 'welcome' || currentStep === 'preview'}
		></div>
		<div class="flex flex-col items-center gap-2">
			<div
				class="w-16 h-16 rounded-full flex items-center justify-center font-black text-2xl border-4 border-black transition-all duration-300"
				class:bg-pastel-purple-200={currentStep === 'indexing'}
				class:shadow-brutalist-sm={currentStep === 'indexing'}
				class:bg-emerald-400={currentStep === 'indexed' ||
					currentStep === 'grouping' ||
					currentStep === 'reviewing'}
				class:text-white={currentStep === 'indexed' ||
					currentStep === 'grouping' ||
					currentStep === 'reviewing'}
				class:bg-gray-200={currentStep !== 'indexing' &&
					currentStep !== 'indexed' &&
					currentStep !== 'grouping' &&
					currentStep !== 'reviewing'}
			>
				2
			</div>
			<div
				class="text-sm font-bold"
				class:text-black={currentStep === 'indexing'}
				class:text-gray-500={currentStep !== 'indexing'}
			>
				Index Photos
			</div>
		</div>
		<div
			class="w-20 h-1 mx-1 transition-all duration-300"
			class:bg-emerald-400={currentStep === 'indexed' ||
				currentStep === 'grouping' ||
				currentStep === 'reviewing'}
			class:bg-gray-300={currentStep === 'welcome' ||
				currentStep === 'preview' ||
				currentStep === 'indexing'}
		></div>
		<div class="flex flex-col items-center gap-2">
			<div
				class="w-16 h-16 rounded-full flex items-center justify-center font-black text-2xl border-4 border-black transition-all duration-300"
				class:bg-pastel-blue-200={currentStep === 'indexed' || currentStep === 'grouping'}
				class:shadow-brutalist-sm={currentStep === 'indexed' || currentStep === 'grouping'}
				class:bg-emerald-400={currentStep === 'reviewing'}
				class:text-white={currentStep === 'reviewing'}
				class:bg-gray-200={currentStep !== 'indexed' &&
					currentStep !== 'grouping' &&
					currentStep !== 'reviewing'}
			>
				3
			</div>
			<div
				class="text-sm font-bold"
				class:text-black={currentStep === 'indexed' || currentStep === 'grouping'}
				class:text-gray-500={currentStep !== 'indexed' && currentStep !== 'grouping'}
			>
				Find Duplicates
			</div>
		</div>
		<div
			class="w-20 h-1 mx-1 transition-all duration-300"
			class:bg-emerald-400={currentStep === 'reviewing'}
			class:bg-gray-300={currentStep !== 'reviewing'}
		></div>
		<div class="flex flex-col items-center gap-2">
			<div
				class="w-16 h-16 rounded-full flex items-center justify-center font-black text-2xl border-4 border-black transition-all duration-300"
				class:bg-pastel-pink-300={currentStep === 'reviewing'}
				class:shadow-brutalist-sm={currentStep === 'reviewing'}
				class:bg-gray-200={currentStep !== 'reviewing'}
			>
				4
			</div>
			<div
				class="text-sm font-bold"
				class:text-black={currentStep === 'reviewing'}
				class:text-gray-500={currentStep !== 'reviewing'}
			>
				Review & Delete
			</div>
		</div>
	</div>

	<!-- Main Content -->
	<main class="cozy-card shadow-brutalist-lg min-h-[400px] p-12">
		{#if currentStep === 'welcome'}
			<!-- Welcome Screen -->
			<div class="text-center max-w-2xl mx-auto py-10 px-5">
				<div class="text-8xl mb-6 animate-[gentle-bounce_4s_ease-in-out_infinite]">📷</div>
				<h2 class="text-5xl font-black text-black mb-4 tracking-tight">Welcome to Lens Cleaner!</h2>
				<p class="text-xl text-brutalist-gray mb-12 leading-relaxed font-medium">
					Let's find and remove duplicate photos from your Google Photos library.
				</p>
				<div class="flex flex-col gap-6 text-left">
					<div class="flex items-start gap-4 bg-pastel-pink-100 p-5 rounded-2xl border-4 border-black shadow-brutalist-sm">
						<div class="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center font-black flex-shrink-0">
							1
						</div>
						<div class="text-base text-brutalist-gray leading-relaxed">
							<strong class="text-black">Click the extension icon</strong> while on Google Photos
						</div>
					</div>
					<div class="flex items-start gap-4 bg-pastel-purple-100 p-5 rounded-2xl border-4 border-black shadow-brutalist-sm">
						<div class="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center font-black flex-shrink-0">
							2
						</div>
						<div class="text-base text-brutalist-gray leading-relaxed">
							<strong class="text-black">Click "Find Duplicates"</strong> to scan your photos
						</div>
					</div>
					<div class="flex items-start gap-4 bg-pastel-blue-100 p-5 rounded-2xl border-4 border-black shadow-brutalist-sm">
						<div class="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center font-black flex-shrink-0">
							3
						</div>
						<div class="text-base text-brutalist-gray leading-relaxed">
							<strong class="text-black">Come back here</strong> to see and delete duplicates
						</div>
					</div>
				</div>
			</div>
		{:else if currentStep === 'preview'}
			<!-- Preview Screen -->
			<div class="p-5">
				<div class="flex justify-between items-start mb-8 pb-6 border-b-4 border-black">
					<div>
						<h2 class="text-4xl font-black text-black mb-2">📷 {$appStore.stats.totalPhotos} Photos Scanned</h2>
						<p class="text-lg text-brutalist-gray font-semibold">Review your scanned photos before indexing</p>
					</div>
					<div class="flex gap-3">
						<button
							onclick={handleStartIndexing}
							class="px-6 py-3 bg-gradient-to-br from-pastel-pink-200 to-pastel-pink-300 text-black font-black text-lg rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
						>
							🧠 Start Indexing
						</button>
					</div>
				</div>

				<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
					{#each sortedPhotos as photo (photo.id)}
						<div class="aspect-square rounded-xl overflow-hidden bg-gray-100 border-2 border-black">
							<img src="data:image/jpeg;base64,{photo.base64}" alt="Scanned" loading="lazy" class="w-full h-full object-cover" />
						</div>
					{/each}
				</div>
			</div>
		{:else if currentStep === 'indexed'}
			<!-- Indexed Screen - Show indexed photos with grouping options -->
			<div class="p-5">
				<div class="flex justify-between items-start mb-8 pb-6 border-b-4 border-black">
					<div class="flex flex-col gap-3">
						<button
							onclick={handleReindex}
							class="px-4 py-2 bg-gray-200 border-2 border-black rounded-lg text-sm font-bold text-brutalist-gray hover:bg-gray-300 transition-all self-start"
						>
							← Reindex
						</button>
						<div>
							<h2 class="text-4xl font-black text-black mb-2">✅ {$appStore.stats.photosWithEmbeddings} Photos Indexed</h2>
							<p class="text-lg text-brutalist-gray font-semibold">
								Ready to find duplicates. Adjust settings if needed before grouping.
							</p>
						</div>
					</div>
					<div class="flex gap-3">
						<button
							onclick={handleStartGrouping}
							class="px-6 py-3 bg-gradient-to-br from-pastel-blue-200 to-pastel-blue-300 text-black font-black text-lg rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
						>
							🔍 Start Grouping
						</button>
						<button
							onclick={handleOpenSettings}
							class="px-4 py-3 bg-pastel-purple-100 border-4 border-black rounded-xl text-2xl flex items-center justify-center hover:bg-pastel-purple-200 transition-all"
						>
							⚙️
						</button>
					</div>
				</div>

				<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
					{#each sortedPhotos as photo (photo.id)}
						<div class="aspect-square rounded-xl overflow-hidden bg-gray-100 border-2 border-black">
							<img src="data:image/jpeg;base64,{photo.base64}" alt="Indexed" loading="lazy" class="w-full h-full object-cover" />
						</div>
					{/each}
				</div>
			</div>
		{:else if currentStep === 'indexing' || currentStep === 'grouping'}
			<!-- Processing Screen -->
			<div class="text-center py-5 px-2.5">
				<div class="w-16 h-16 border-4 border-gray-300 border-t-black rounded-full animate-spin mx-auto mb-8"></div>
				<h2 class="text-4xl font-black text-black mb-3">
					{#if currentStep === 'indexing'}
						🧠 Indexing your photos...
					{:else}
						🔍 Finding duplicates...
					{/if}
				</h2>
				<p class="text-lg text-brutalist-gray mb-10 font-medium">
					{#if $appStore.processingProgress.message}
						{$appStore.processingProgress.message}
					{:else}
						This may take a few moments. We're using AI to compare your photos.
					{/if}
				</p>

				<div class="grid grid-cols-2 gap-5 max-w-lg mx-auto mb-8">
					<div class="bg-pastel-pink-100 p-6 rounded-2xl border-4 border-black shadow-brutalist-sm">
						<div class="text-5xl font-black text-black mb-2">{$appStore.stats.totalPhotos}</div>
						<div class="text-sm text-brutalist-gray uppercase tracking-wide font-bold">
							{#if currentStep === 'indexing'}
								Photos Scanned
							{:else}
								Photos Indexed
							{/if}
						</div>
					</div>
					<div class="bg-pastel-purple-100 p-6 rounded-2xl border-4 border-black shadow-brutalist-sm">
						<div class="text-5xl font-black text-black mb-2">
							{#if $appStore.processingProgress.isProcessing}
								{$appStore.processingProgress.current}
							{:else if currentStep === 'indexing'}
								{$appStore.stats.photosWithEmbeddings}
							{:else}
								{$appStore.stats.totalGroups}
							{/if}
						</div>
						<div class="text-sm text-brutalist-gray uppercase tracking-wide font-bold">
							{#if currentStep === 'indexing'}
								Photos Analyzed
							{:else}
								Groups Found
							{/if}
						</div>
					</div>
				</div>

				{#if $appStore.processingProgress.isProcessing && $appStore.processingProgress.total > 0}
					<div class="max-w-2xl mx-auto mt-8">
						<div class="flex items-center gap-3 mb-3">
							<span class="text-2xl font-black text-black min-w-[60px]">
								{Math.floor(
									($appStore.processingProgress.current / $appStore.processingProgress.total) * 100
								)}%
							</span>
							<div class="flex-1 h-4 bg-gray-200 rounded-md overflow-hidden border-2 border-black">
								<div
									class="h-full bg-gradient-to-r from-pastel-pink-300 to-pastel-purple-300 transition-all duration-300"
									style="width: {($appStore.processingProgress.current /
										$appStore.processingProgress.total) *
										100}%"
								></div>
							</div>
						</div>
						<div class="flex justify-end items-center">
							{#if estimatedTimeRemaining > 0}
								<span class="text-sm text-black font-bold">
									~{formatTimeEstimate(estimatedTimeRemaining)} remaining
								</span>
							{/if}
						</div>
					</div>
				{/if}

				<div class="mt-12 py-4 px-6 bg-pastel-blue-100 border-4 border-black rounded-2xl inline-flex items-center gap-2.5 max-w-3xl shadow-brutalist-sm">
					<span class="text-2xl flex-shrink-0">💡</span>
					<span class="text-sm text-black leading-relaxed font-semibold"
						>You can background this tab or close it. Processing continues and progress is saved.</span
					>
				</div>
			</div>
		{:else if currentStep === 'reviewing'}
			<!-- Review Screen -->
			{#if displayGroups.length === 0 && ungroupedPhotos.length === 0}
				<div class="text-center py-20 px-5">
					<div class="text-8xl mb-6">✨</div>
					<h2 class="text-5xl font-black text-black mb-3">No duplicates found!</h2>
					<p class="text-xl text-brutalist-gray mb-8 font-medium">Your photos are already clean.</p>
					<div class="flex gap-3 justify-center flex-wrap">
						<button
							onclick={handleRegroup}
							class="px-6 py-3 bg-pastel-purple-200 text-black font-bold rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
						>
							🔄 Regroup
						</button>
						<button
							onclick={handleReindex}
							class="px-6 py-3 bg-pastel-blue-200 text-black font-bold rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
						>
							🔄 Reindex
						</button>
						<button
							onclick={handleRescan}
							class="px-6 py-3 bg-pastel-pink-200 text-black font-bold rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
						>
							⚠️ Rescan from Scratch
						</button>
					</div>
				</div>
			{:else}
				<div>
					{#if displayGroups.length > 0}
						<div class="flex justify-between items-start mb-8 pb-6 border-b-4 border-black">
							<div class="flex flex-col gap-3">
								<button
									onclick={handleRegroup}
									class="px-4 py-2 bg-gray-200 border-2 border-black rounded-lg text-sm font-bold text-brutalist-gray hover:bg-gray-300 transition-all self-start"
								>
									← Regroup
								</button>
								<div>
									<h2 class="text-4xl font-black text-black mb-2">Found {displayGroups.length} duplicate groups</h2>
									<p class="text-lg text-brutalist-gray font-semibold">Click photos to mark for deletion</p>
								</div>
							</div>
							<div class="flex gap-3">
								{#if $appStore.selectedPhotos.size > 0}
									<button
										onclick={handleClearSelection}
										class="px-6 py-3 bg-pastel-purple-200 text-black font-bold rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all whitespace-nowrap"
									>
										Clear ({$appStore.selectedPhotos.size})
									</button>
									<button
										onclick={handleDeleteFromGooglePhotos}
										class="px-6 py-3 bg-gradient-to-br from-pastel-pink-200 to-pastel-pink-300 text-black font-black text-lg rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all whitespace-nowrap"
									>
										📸 Delete from Google Photos
									</button>
								{/if}
							</div>
						</div>

						<!-- Duplicate Groups -->
						<div class="flex flex-col gap-8 mb-12">
							{#each displayGroups as group (group.id)}
								{#await getGroupPhotos(group)}
									<div class="bg-pastel-pink-50 rounded-2xl p-6 border-4 border-black shadow-brutalist min-h-[200px] flex items-center justify-center">
										<div class="w-10 h-10 border-4 border-gray-300 border-t-black rounded-full animate-spin"></div>
									</div>
								{:then photos}
									<div class="organic-texture cozy-card shadow-brutalist hover:shadow-brutalist-lg hover:border-black transition-all p-6">
										<div class="flex justify-between items-center mb-5">
											<h3 class="text-2xl font-black text-black">Duplicate Group ({photos.length} photos)</h3>
											<button
												onclick={() => selectAllInGroup(group.id)}
												class="bg-none border-none text-black text-sm font-bold cursor-pointer px-2 py-1 hover:underline"
											>
												Select All
											</button>
										</div>
										<div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
											{#each photos as photo (photo.id)}
												<button
													class="relative aspect-square rounded-xl overflow-hidden cursor-pointer border-4 transition-all bg-none p-0"
													class:border-red-500={$appStore.selectedPhotos.has(photo.id)}
													class:border-transparent={!$appStore.selectedPhotos.has(photo.id)}
													class:shadow-brutalist-sm={!$appStore.selectedPhotos.has(photo.id)}
													class:hover:scale-105={true}
													class:hover:shadow-brutalist={true}
													onclick={() => togglePhotoSelection(photo.id)}
													type="button"
												>
													<img
														src="data:image/jpeg;base64,{photo.base64}"
														alt="Duplicate"
														loading="lazy"
														class="w-full h-full object-cover"
													/>
													<div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3 flex justify-center">
														{#if $appStore.selectedPhotos.has(photo.id)}
															<div class="bg-red-500 text-white px-3 py-1.5 rounded-full text-xs font-black">
																✓ Will Delete
															</div>
														{:else}
															<div class="bg-white/90 text-black px-3 py-1.5 rounded-full text-xs font-bold">
																Click to Select
															</div>
														{/if}
													</div>
												</button>
											{/each}
										</div>
									</div>
								{/await}
							{/each}
						</div>
					{/if}

					<!-- Ungrouped Photos -->
					{#if ungroupedPhotos.length > 0}
						<div class="mt-12 pt-12 border-t-4 border-dashed border-black/20">
							<div class="mb-6">
								<h2 class="text-3xl font-black text-black mb-2">📷 {ungroupedPhotos.length} Unique Photos</h2>
								<p class="text-lg text-brutalist-gray font-semibold">These photos have no duplicates</p>
							</div>
							<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
								{#each ungroupedPhotos as photo (photo.id)}
									<div class="aspect-square rounded-xl overflow-hidden bg-gray-100 border-2 border-black">
										<img src="data:image/jpeg;base64,{photo.base64}" alt="Unique" loading="lazy" class="w-full h-full object-cover" />
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</main>
</div>

<!-- Settings Modal -->
{#if showSettings}
	<div
		class="fixed top-0 left-0 w-full h-full bg-black/50 flex items-center justify-center z-[1000] backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) {
				showSettings = false;
			}
		}}
		onkeydown={(e) => e.key === 'Escape' && (showSettings = false)}
	>
		<div class="cozy-card shadow-brutalist-lg w-[90%] max-w-2xl max-h-[90vh] overflow-y-auto" role="document">
			<div class="flex justify-between items-center p-6 border-b-4 border-black">
				<h2 id="settings-title" class="text-3xl font-black text-black">⚙️ Settings</h2>
				<button
					class="bg-none border-none text-5xl text-gray-400 cursor-pointer leading-none p-0 w-8 h-8 hover:text-gray-800 transition-colors"
					onclick={() => (showSettings = false)}
				>
					&times;
				</button>
			</div>
			<div class="p-6">
				<div class="mb-8">
					<label for="similarityThreshold" class="flex flex-col gap-1 mb-3">
						<strong class="text-black text-lg">Match Sensitivity</strong>
						<span class="text-sm text-brutalist-gray font-medium">How similar photos need to be</span>
					</label>
					<div class="flex items-center gap-3 mb-2">
						<span class="text-sm text-brutalist-gray min-w-[50px] font-semibold">Loose</span>
						<input
							type="range"
							id="similarityThreshold"
							bind:value={similaritySliderPosition}
							min="0"
							max="100"
							step="1"
							class="flex-1 h-2 rounded-full bg-gray-200 outline-none appearance-none border-2 border-black [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:border-none"
						/>
						<span class="text-sm text-brutalist-gray min-w-[50px] font-semibold">Strict</span>
					</div>
					<span class="text-sm text-black font-bold mb-1 block">{similaritySliderPosition}% match required</span>
					<span class="text-sm text-brutalist-gray">Lower values group more photos together (default: 70%)</span>
				</div>

				<div class="mb-8">
					<label for="timeWindow" class="flex flex-col gap-1 mb-3">
						<strong class="text-black text-lg">Time Window</strong>
						<span class="text-sm text-brutalist-gray font-medium">Photos taken within this time can be grouped</span>
					</label>
					<input
						type="number"
						id="timeWindow"
						bind:value={editingSettings.timeWindowMinutes}
						min="5"
						max="1440"
						step="5"
						class="w-full p-2.5 border-4 border-black rounded-xl text-sm mb-1 font-semibold focus:outline-none focus:ring-4 focus:ring-pastel-purple-200"
					/>
					<span class="text-sm text-brutalist-gray block mb-1">minutes</span>
					<span class="text-sm text-brutalist-gray"
						>Photos taken within this time window can be grouped (default: 60 minutes)</span
					>
				</div>

				<div class="mb-0">
					<label for="minGroupSize" class="flex flex-col gap-1 mb-3">
						<strong class="text-black text-lg">Minimum Photos per Group</strong>
						<span class="text-sm text-brutalist-gray font-medium">Only show groups with at least this many photos</span>
					</label>
					<input
						type="number"
						id="minGroupSize"
						bind:value={editingSettings.minGroupSize}
						min="2"
						max="10"
						class="w-full p-2.5 border-4 border-black rounded-xl text-sm mb-1 font-semibold focus:outline-none focus:ring-4 focus:ring-pastel-purple-200"
					/>
					<span class="text-sm text-brutalist-gray">photos</span>
				</div>
			</div>
			<div class="p-6 border-t-4 border-black flex justify-end gap-3">
				<button
					class="px-6 py-3 bg-pastel-purple-200 text-black font-bold rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
					onclick={() => (showSettings = false)}
				>
					Cancel
				</button>
				<button
					class="px-6 py-3 bg-gradient-to-br from-pastel-pink-200 to-pastel-pink-300 text-black font-black rounded-xl border-4 border-black shadow-brutalist hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutalist-lg transition-all"
					onclick={handleSaveSettings}
				>
					Save
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Gentle bounce animation for welcome screen */
	@keyframes gentle-bounce {
		0%,
		100% {
			transform: translateY(0px) rotate(0deg);
		}
		25% {
			transform: translateY(-8px) rotate(-2deg);
		}
		75% {
			transform: translateY(-5px) rotate(2deg);
		}
	}

	/* Responsive adjustments */
	@media (max-width: 768px) {
		.cozy-card {
			padding: 24px !important;
		}
	}
</style>
