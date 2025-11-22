<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Photo, Group } from '../lib/db';
	import PhotoGrid from './PhotoGrid.svelte';
	import DuplicateGroup from './DuplicateGroup.svelte';
	import PaymentModal from './PaymentModal.svelte';
	import AutoSelectProcessingBanner from './AutoSelectProcessingBanner.svelte';
	import db from '../lib/db';

	export let displayGroups: Group[] = []; // Initial groups (can be empty for pagination)
	export let ungroupedPhotos: Photo[];
	export let selectedCount: number;
	export let onToggleSelection: (photoId: string) => void;
	export let onSelectAllInGroup: (groupId: string) => void;
	export let onClearSelection: () => void;
	export let onDeleteFromGooglePhotos: () => void;
	export let onRegroup: () => void;
	export let onReindex: () => void;
	export let onRescan: () => void;
	export let getCachedBlobUrl: (photo: Photo) => string;
	export let getGroupPhotos: (group: Group) => Promise<Photo[]>;

	// Pagination props
	export let enableGroupPagination = false;
	export let totalGroupsCount: number = 0;

	const GROUPS_PER_PAGE = 20;
	let paginatedGroups: Group[] = displayGroups;
	let loadedGroupsCount = displayGroups.length; // Start from the number of groups already loaded
	let initialDisplayGroupsLength = displayGroups.length; // Track initial length to detect resets
	let isInitialized = false; // Track if pagination has been initialized
	let isLoadingGroups = false;
	let groupsContainer: HTMLElement | null = null;

	// Auto-select props
	export let autoSelectStatus:
		| 'idle'
		| 'payment'
		| 'ready'
		| 'uploading'
		| 'processing'
		| 'completed'
		| 'failed'
		| 'tampered' = 'idle';
	export let autoSelectProgress: number = 0;
	export let autoSelectError: string = '';
	export let onAutoSelect: () => void;
	export let onCheckoutCreated: (
		checkoutUrl: string,
		checkoutId: string,
		jobId: string,
		amount: number
	) => void;
	export let onStartUpload: () => void;
	export let totalPhotosCount: number = 0;
	export let canRetryAutoSelect: boolean = false;
	export let canRefundAutoSelect: boolean = false;
	export let onRetryAutoSelect: () => void = () => {};
	export let onRefundAutoSelect: () => void = () => {};
	export let refundLoading: boolean = false;

	let showPaymentModal = false;

	// Pagination logic
	onMount(async () => {
		if (enableGroupPagination && totalGroupsCount > 0) {
			// Initialize loadedGroupsCount to match the groups already in displayGroups
			loadedGroupsCount = displayGroups.length;
			initialDisplayGroupsLength = displayGroups.length;
			isInitialized = true; // Mark as initialized so reactive statement can handle resets
			// Load initial batch immediately if we have room for more
			// This ensures we show more than just the initial 50 groups
			if (loadedGroupsCount < totalGroupsCount) {
				// Load enough to fill the first page (at least GROUPS_PER_PAGE more)
				const groupsToLoad = Math.min(GROUPS_PER_PAGE, totalGroupsCount - loadedGroupsCount);
				const batch = await db.getGroupsBatch(loadedGroupsCount, groupsToLoad);
				paginatedGroups = [...paginatedGroups, ...batch];
				loadedGroupsCount += batch.length;
			}
			setupGroupScrollListener();
			// Check if we're already scrolled down and need to load more
			setTimeout(() => {
				if (scrollHandler) {
					scrollHandler();
				}
			}, 100);
		} else {
			paginatedGroups = displayGroups;
		}
	});

	async function loadMoreGroups() {
		if (!enableGroupPagination) return;
		if (isLoadingGroups || loadedGroupsCount >= totalGroupsCount) return;

		isLoadingGroups = true;
		try {
			const batch = await db.getGroupsBatch(loadedGroupsCount, GROUPS_PER_PAGE);
			paginatedGroups = [...paginatedGroups, ...batch];
			loadedGroupsCount += batch.length;
		} finally {
			isLoadingGroups = false;
		}
	}

	let scrollHandler: (() => void) | null = null;

	function setupGroupScrollListener() {
		scrollHandler = () => {
			if (isLoadingGroups || loadedGroupsCount >= totalGroupsCount) return;

			// Check window scroll (most common case)
			const windowHeight = window.innerHeight;
			const documentHeight = document.documentElement.scrollHeight;
			const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

			// Load more when 80% scrolled
			if (scrollTop + windowHeight > documentHeight * 0.8) {
				loadMoreGroups();
				return;
			}

			// Also check container scroll if it exists and is scrollable
			if (groupsContainer) {
				const {
					scrollTop: containerScrollTop,
					scrollHeight: containerScrollHeight,
					clientHeight: containerClientHeight
				} = groupsContainer;
				if (containerScrollTop + containerClientHeight > containerScrollHeight * 0.8) {
					loadMoreGroups();
				}
			}
		};

		// Always listen to window scroll (main scroll mechanism)
		if (scrollHandler) {
			window.addEventListener('scroll', scrollHandler, { passive: true });
		}

		// Also try to find and listen to container scroll if it exists
		let retries = 0;
		const findContainer = setInterval(() => {
			groupsContainer = document.querySelector('.review-screen-container');
			if (groupsContainer || retries++ > 10) {
				clearInterval(findContainer);
				if (groupsContainer && scrollHandler) {
					groupsContainer.addEventListener('scroll', scrollHandler);
				}
			}
		}, 100);
	}

	onDestroy(() => {
		// Clean up scroll listeners
		if (scrollHandler) {
			if (groupsContainer) {
				groupsContainer.removeEventListener('scroll', scrollHandler);
			}
			window.removeEventListener('scroll', scrollHandler);
		}
	});

	// Update paginatedGroups when displayGroups changes
	// For pagination mode, we only reset if displayGroups actually changed (e.g., after regroup)
	// We don't want to reset just because displayGroups stays at initial size while we paginate
	$: if (!enableGroupPagination) {
		paginatedGroups = displayGroups;
	} else if (
		enableGroupPagination &&
		isInitialized &&
		displayGroups.length !== initialDisplayGroupsLength
	) {
		// displayGroups was refreshed/reset (e.g., after regroup), so reset pagination
		initialDisplayGroupsLength = displayGroups.length;
		loadedGroupsCount = displayGroups.length;
		paginatedGroups = displayGroups;
	}

	function handleAutoSelect() {
		showPaymentModal = true;
		onAutoSelect();
	}

	function handleCheckoutCreated(
		checkoutUrl: string,
		checkoutId: string,
		jobId: string,
		amount: number
	) {
		showPaymentModal = false;
		onCheckoutCreated(checkoutUrl, checkoutId, jobId, amount);
	}
</script>

{#if paginatedGroups.length === 0 && ungroupedPhotos.length === 0}
	<div class="px-5 py-20 text-center">
		<div class="mb-6 text-8xl">✨</div>
		<h2 class="mb-3 text-5xl font-black text-black">No duplicates found!</h2>
		<p class="mb-8 text-xl font-medium text-brutalist-gray">Your photos are already clean.</p>
		<div class="flex flex-wrap justify-center gap-3">
			<button
				onclick={onRegroup}
				class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-purple-200 px-6 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
			>
				🔄 Regroup
			</button>
			<button
				onclick={onReindex}
				class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-blue-200 px-6 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
			>
				🔄 Reindex
			</button>
			<button
				onclick={onRescan}
				class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-pink-200 px-6 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
			>
				⚠️ Rescan from Scratch
			</button>
		</div>
	</div>
{:else}
	<div class="review-screen-container {enableGroupPagination ? 'h-full overflow-y-auto' : ''}">
		<!-- Auto-select Processing Banner -->
		{#if autoSelectStatus === 'uploading'}
			<AutoSelectProcessingBanner
				status="uploading"
				uploadProgress={autoSelectProgress}
				message=""
			/>
		{:else if autoSelectStatus === 'processing'}
			<AutoSelectProcessingBanner status="processing" uploadProgress={0} message="" />
		{:else if autoSelectStatus === 'completed'}
			<AutoSelectProcessingBanner status="completed" uploadProgress={100} message="" />
		{:else if autoSelectStatus === 'tampered'}
			<AutoSelectProcessingBanner status="tampered" uploadProgress={0} message={autoSelectError} />
		{:else if autoSelectStatus === 'failed'}
			<AutoSelectProcessingBanner
				status="failed"
				uploadProgress={0}
				message={autoSelectError}
				canRetry={canRetryAutoSelect}
				onRetry={onRetryAutoSelect}
				canRefund={canRefundAutoSelect}
				onRefund={onRefundAutoSelect}
				{refundLoading}
			/>
		{/if}

		{#if paginatedGroups.length > 0 || (enableGroupPagination && totalGroupsCount > 0)}
			<div class="mb-8 flex items-start justify-between border-b-4 border-black pb-6">
				<div class="flex flex-col gap-3">
					<button
						onclick={onRegroup}
						class="self-start rounded-lg border-2 border-black bg-gray-200 px-4 py-2 text-sm font-bold text-brutalist-gray transition-all hover:bg-gray-300"
						disabled={autoSelectStatus === 'processing' ||
							autoSelectStatus === 'uploading' ||
							autoSelectStatus === 'ready'}
					>
						← Regroup
					</button>
					<div>
						<h2 class="mb-2 text-4xl font-black text-black">
							Found {enableGroupPagination ? totalGroupsCount : paginatedGroups.length} duplicate groups
						</h2>
						<p class="text-lg font-semibold text-brutalist-gray">
							Click photos to mark for deletion
						</p>
					</div>
				</div>
				<div class="flex flex-wrap gap-3">
					<!-- Auto-select button (shown when idle) -->
					{#if autoSelectStatus === 'idle' && selectedCount === 0}
						<button
							onclick={handleAutoSelect}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-gradient-to-r from-purple-500 to-pink-500 px-6 py-3 text-lg font-black whitespace-nowrap text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
						>
							🤖 Auto Select
						</button>
					{/if}

					<!-- Verifying payment loader -->
					{#if autoSelectStatus === 'payment'}
						<button
							disabled
							class="shadow-brutalist flex items-center justify-center gap-3 rounded-xl border-4 border-black bg-gradient-to-r from-yellow-400 to-yellow-500 px-6 py-3 text-lg font-black whitespace-nowrap text-white transition-all disabled:opacity-75"
						>
							<div
								class="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-black"
							></div>
							⏳ Verifying payment...
						</button>
					{/if}

					<!-- Start Upload button (shown when ready) -->
					{#if autoSelectStatus === 'ready'}
						<button
							onclick={onStartUpload}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-gradient-to-r from-green-500 to-emerald-500 px-6 py-3 text-lg font-black whitespace-nowrap text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
						>
							⬆️ Start Upload
						</button>
					{/if}

					{#if selectedCount > 0}
						<button
							onclick={onClearSelection}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-purple-200 px-6 py-3 font-bold whitespace-nowrap text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
							disabled={autoSelectStatus === 'uploading'}
						>
							Clear ({selectedCount})
						</button>
						<button
							onclick={onDeleteFromGooglePhotos}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-linear-to-br from-pastel-pink-200 to-pastel-pink-300 px-6 py-3 text-lg font-black whitespace-nowrap text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
							disabled={autoSelectStatus === 'uploading'}
						>
							📸 Delete from Google Photos
						</button>
					{/if}
				</div>
			</div>

			<!-- Duplicate Groups -->
			<div class="mb-12 flex flex-col gap-8">
				{#each paginatedGroups as group (group.id)}
					{#await getGroupPhotos(group)}
						<div
							class="shadow-brutalist flex min-h-[200px] items-center justify-center rounded-2xl border-4 border-black bg-pastel-pink-50 p-6"
						>
							<div
								class="h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-black"
							></div>
						</div>
					{:then photos}
						<DuplicateGroup
							{group}
							{photos}
							{onToggleSelection}
							{onSelectAllInGroup}
							{getCachedBlobUrl}
						/>
					{/await}
				{/each}

				<!-- Loading indicator for groups -->
				{#if enableGroupPagination && isLoadingGroups}
					<div class="flex justify-center p-8">
						<div
							class="h-10 w-10 animate-spin rounded-full border-4 border-gray-300 border-t-black"
						></div>
					</div>
				{/if}

				<!-- All groups loaded message -->
				{#if enableGroupPagination && loadedGroupsCount >= totalGroupsCount && paginatedGroups.length > 0}
					<div class="p-4 text-center text-sm text-gray-500">
						All {totalGroupsCount} groups loaded
					</div>
				{/if}
			</div>
		{/if}

		<!-- Ungrouped Photos - Only show after all groups are loaded -->
		{#if ungroupedPhotos.length > 0 && (!enableGroupPagination || loadedGroupsCount >= totalGroupsCount)}
			<div class="mt-12 border-t-4 border-dashed border-black/20 pt-12">
				<div class="mb-6">
					<h2 class="mb-2 text-3xl font-black text-black">
						📷 {ungroupedPhotos.length} Unique Photos
					</h2>
					<p class="text-lg font-semibold text-brutalist-gray">These photos have no duplicates</p>
				</div>
				<PhotoGrid photos={ungroupedPhotos} {getCachedBlobUrl} />
			</div>
		{/if}
	</div>
{/if}

<!-- Payment Modal -->
<PaymentModal
	show={showPaymentModal}
	photoCount={totalPhotosCount}
	onClose={() => (showPaymentModal = false)}
	onCheckoutCreated={handleCheckoutCreated}
/>
