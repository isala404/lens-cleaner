<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Photo } from '../lib/db';
	import { appStore, isPhotoSelected } from '../stores/appStore';
	import { SvelteMap } from 'svelte/reactivity';
	import db from '../lib/db';

	export let photos: Photo[] = []; // For static lists (e.g., within groups)
	export let getCachedBlobUrl: (photo: Photo) => string;
	export let selectable = false;
	export let onToggleSelection: ((photoId: string) => void) | undefined = undefined;

	// Pagination props (optional - if provided, will paginate from database)
	export let totalPhotos: number | undefined = undefined;
	export let enablePagination = false;

	const BATCH_SIZE = 100; // Load 100 photos at a time
	const INITIAL_LOAD = 200; // Load 200 initially

	let displayPhotos: Photo[] = photos;
	let loadedCount = 0;
	let isLoading = false;
	let scrollContainer: HTMLElement | null = null;
	let sentinelElement: HTMLElement | null = null;
	let intersectionObserver: IntersectionObserver | null = null;

	let hoveredPhotoId: string | null = null;
	// Track selection state for each photo
	let photoSelectionState: SvelteMap<string, boolean> = new SvelteMap();

	// Pagination mode: load photos from database
	onMount(async () => {
		if (enablePagination && totalPhotos !== undefined) {
			await loadMore(INITIAL_LOAD);
			setupScrollListener();
		} else {
			// Static mode: use photos prop
			displayPhotos = photos;
			loadSelectionStates();
		}
	});

	// Cleanup on destroy
	onDestroy(() => {
		if (intersectionObserver) {
			intersectionObserver.disconnect();
		}
		if (scrollContainer) {
			scrollContainer.removeEventListener('scroll', checkScroll);
		}
		window.removeEventListener('scroll', checkWindowScroll);
	});

	async function loadMore(count: number) {
		if (!enablePagination || totalPhotos === undefined) return;
		if (isLoading || loadedCount >= totalPhotos) return;

		isLoading = true;
		try {
			const batch = await db.getPhotosBatch(loadedCount, count);
			displayPhotos = [...displayPhotos, ...batch];
			// eslint-disable-next-line svelte/infinite-reactive-loop -- Guard at function start prevents infinite loop
			loadedCount += batch.length;
			await loadSelectionStates();
		} finally {
			// eslint-disable-next-line svelte/infinite-reactive-loop -- Guard at function start prevents infinite loop
			isLoading = false;
		}
	}

	function checkScroll() {
		if (!scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		// Load more when 80% scrolled
		if (scrollTop + clientHeight > scrollHeight * 0.8 && !isLoading) {
			loadMore(BATCH_SIZE);
		}
	}

	function setupScrollListener() {
		// Try to find scroll container
		let retries = 0;
		const findContainer = setInterval(() => {
			scrollContainer = document.querySelector('.photo-grid-container');
			if (scrollContainer || retries++ > 10) {
				clearInterval(findContainer);
				if (scrollContainer) {
					// Check if container is actually scrollable
					const isScrollable = scrollContainer.scrollHeight > scrollContainer.clientHeight;
					if (isScrollable) {
						// Container is scrollable, use scroll event
						scrollContainer.addEventListener('scroll', checkScroll);
					} else {
						// Container is not scrollable, use Intersection Observer on sentinel
						setupIntersectionObserver();
					}
				} else {
					// No container found, use window scroll or Intersection Observer
					setupIntersectionObserver();
				}
			}
		}, 100);
	}

	function setupIntersectionObserver() {
		// Use Intersection Observer API as fallback - works with any scroll container
		if (typeof IntersectionObserver === 'undefined') {
			// Fallback to window scroll if IntersectionObserver not available
			window.addEventListener('scroll', checkWindowScroll);
			return;
		}

		// Observer will be set up when sentinel element is available (via reactive statement)
	}

	function checkWindowScroll() {
		if (isLoading || loadedCount >= (totalPhotos || 0)) return;
		const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
		const windowHeight = window.innerHeight;
		const documentHeight = document.documentElement.scrollHeight;
		// Load more when 80% scrolled
		if (scrollTop + windowHeight > documentHeight * 0.8) {
			loadMore(BATCH_SIZE);
		}
	}

	// Load selection state for all photos
	async function loadSelectionStates() {
		const states = new SvelteMap<string, boolean>();
		for (const photo of displayPhotos) {
			const selected = await isPhotoSelected(photo.id);
			states.set(photo.id, selected);
		}
		photoSelectionState = states;
	}

	// Reload selection states when photos change (static mode)
	$: if (!enablePagination && photos) {
		displayPhotos = photos;
		loadSelectionStates();
	}

	// Subscribe to selectedPhotosCount changes to refresh states
	$: if ($appStore.selectedPhotosCount !== undefined) {
		loadSelectionStates();
	}

	// Set up Intersection Observer when sentinel element is available
	$: if (
		enablePagination &&
		sentinelElement &&
		typeof IntersectionObserver !== 'undefined' &&
		!intersectionObserver
	) {
		intersectionObserver = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting && !isLoading && loadedCount < (totalPhotos || 0)) {
						// eslint-disable-next-line svelte/infinite-reactive-loop -- Guarded by isLoading and loadedCount check
						loadMore(BATCH_SIZE);
					}
				});
			},
			{
				root: scrollContainer || null, // Use container if scrollable, otherwise use viewport
				rootMargin: '200px' // Start loading 200px before reaching the sentinel
			}
		);
		intersectionObserver.observe(sentinelElement);
	}

	function openInGooglePhotos(url: string | undefined, event: MouseEvent | KeyboardEvent) {
		event.stopPropagation();
		if (url) {
			window.open(url, '_blank');
		}
	}

	function handleGooglePhotosKeydown(url: string | undefined, event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openInGooglePhotos(url, event);
		}
	}

	function openPhotoInGooglePhotos(photo: Photo, event: MouseEvent | KeyboardEvent) {
		event.stopPropagation();
		const googlePhotosUrl = `https://photos.google.com/photo/${photo.id}`;
		window.open(googlePhotosUrl, '_blank');
	}

	function handlePhotoKeydown(photo: Photo, event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openPhotoInGooglePhotos(photo, event);
		}
	}

	async function handleToggleSelection(photoId: string) {
		if (onToggleSelection) {
			onToggleSelection(photoId);
			// Update local state immediately for responsiveness
			const currentState = photoSelectionState.get(photoId) || false;
			photoSelectionState.set(photoId, !currentState);
			photoSelectionState = photoSelectionState; // Trigger reactivity
		}
	}
</script>

<div class="photo-grid-container {enablePagination ? 'h-full overflow-y-auto' : ''}">
	<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
		{#each displayPhotos as photo (photo.id)}
			{@const isSelected = photoSelectionState.get(photo.id) || false}
			{#if selectable && onToggleSelection}
				<div class="relative overflow-visible">
					<button
						class="relative aspect-square w-full cursor-pointer overflow-hidden rounded-xl border-4 bg-none p-0 transition-all"
						class:border-red-500={isSelected}
						class:border-transparent={!isSelected}
						class:shadow-brutalist-sm={!isSelected}
						class:hover:scale-105={true}
						class:hover:shadow-brutalist={true}
						onclick={() => handleToggleSelection(photo.id)}
						onmouseenter={() => (hoveredPhotoId = photo.id)}
						onmouseleave={() => (hoveredPhotoId = null)}
						type="button"
					>
						<img
							src={getCachedBlobUrl(photo)}
							alt=""
							loading="lazy"
							class="h-full w-full object-cover"
						/>
						{#if isSelected}
							<div
								class="absolute right-0 bottom-0 left-0 flex justify-center bg-linear-to-t from-black/70 to-transparent p-3"
							>
								<div class="rounded-full bg-red-500 px-3 py-1.5 text-xs font-black text-white">
									✓ Will Delete
								</div>
							</div>
						{:else}
							<div
								class="absolute right-0 bottom-0 left-0 flex justify-center bg-linear-to-t from-black/70 to-transparent p-3"
							>
								<div class="rounded-full bg-white/90 px-3 py-1.5 text-xs font-bold text-black">
									Click to Select
								</div>
							</div>
						{/if}

						<!-- Open Photo Button (shown on hover) -->
						{#if hoveredPhotoId === photo.id}
							<div
								class="absolute top-2 left-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 border-black bg-white text-xs shadow-lg transition-all hover:scale-110"
								onclick={(e) => openPhotoInGooglePhotos(photo, e)}
								onkeydown={(e) => handlePhotoKeydown(photo, e)}
								title="Open photo in Google Photos"
								role="button"
								tabindex="0"
							>
								🔗
							</div>
						{/if}

						<!-- Google Photos Button -->
						{#if photo.googlePhotosUrl}
							<div
								class="absolute top-2 right-12 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 border-black bg-white text-xs shadow-lg transition-all hover:scale-110"
								onclick={(e) => openInGooglePhotos(photo.googlePhotosUrl, e)}
								onkeydown={(e) => handleGooglePhotosKeydown(photo.googlePhotosUrl, e)}
								title="Open in Google Photos"
								role="button"
								tabindex="0"
							>
								📸
							</div>
						{/if}

						<!-- AI Suggestion Badge (only for AI-selected photos) -->
						{#if photo.aiSuggestionReason}
							<div class="pointer-events-none absolute top-2 right-2">
								<div
									class="flex h-7 w-7 items-center justify-center rounded-full border-2 border-black bg-gradient-to-br from-purple-400 to-pink-400 text-xs font-black text-white shadow-lg"
									title="AI Suggested"
								>
									🤖
								</div>
							</div>
						{/if}
					</button>

					<!-- AI Suggestion Popover (shown on hover for AI-selected photos) -->
					{#if photo.aiSuggestionReason && hoveredPhotoId === photo.id}
						<div class="pointer-events-none absolute top-2 right-2 z-[9999]">
							<div class="relative flex items-center justify-center">
								<div
									class="absolute top-1/2 left-1/2 w-96 max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-black bg-white px-3 py-2 shadow-lg"
								>
									<p
										class="text-xs leading-tight font-semibold break-words whitespace-normal text-gray-800"
									>
										{photo.aiSuggestionReason}
									</p>
								</div>
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div
					class="relative aspect-square overflow-hidden rounded-xl border-2 border-black bg-gray-100"
					role="img"
					onmouseenter={() => (hoveredPhotoId = photo.id)}
					onmouseleave={() => (hoveredPhotoId = null)}
				>
					<img
						src={getCachedBlobUrl(photo)}
						alt=""
						loading="lazy"
						class="h-full w-full object-cover"
					/>

					<!-- Open Photo Button for non-selectable photos (shown on hover) -->
					{#if hoveredPhotoId === photo.id}
						<div
							class="absolute top-2 left-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 border-black bg-white text-xs shadow-lg transition-all hover:scale-110"
							onclick={(e) => openPhotoInGooglePhotos(photo, e)}
							onkeydown={(e) => handlePhotoKeydown(photo, e)}
							title="Open photo in Google Photos"
							role="button"
							tabindex="0"
						>
							🔗
						</div>
					{/if}
				</div>
			{/if}
		{/each}
	</div>

	<!-- Sentinel element for Intersection Observer (pagination mode) -->
	{#if enablePagination && totalPhotos !== undefined && loadedCount < totalPhotos}
		<div bind:this={sentinelElement} class="photo-grid-sentinel" style="height: 1px;"></div>
	{/if}

	<!-- Loading indicator (pagination mode) -->
	{#if enablePagination && isLoading}
		<div class="flex justify-center p-8">
			<div class="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-black"></div>
		</div>
	{/if}

	<!-- All loaded message (pagination mode) -->
	{#if enablePagination && totalPhotos !== undefined && loadedCount >= totalPhotos && displayPhotos.length > 0}
		<div class="p-4 text-center text-sm text-gray-500">
			All {totalPhotos} photos loaded
		</div>
	{/if}
</div>
