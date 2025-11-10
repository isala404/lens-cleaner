<script lang="ts">
	import type { Photo, Group } from '../lib/db';
	import PhotoGrid from './PhotoGrid.svelte';
	import DuplicateGroup from './DuplicateGroup.svelte';
	import PaymentModal from './PaymentModal.svelte';
	import AutoSelectProcessingBanner from './AutoSelectProcessingBanner.svelte';

	export let displayGroups: Group[];
	export let ungroupedPhotos: Photo[];
	export let selectedPhotos: Set<string>;
	export let onToggleSelection: (photoId: string) => void;
	export let onSelectAllInGroup: (groupId: string) => void;
	export let onClearSelection: () => void;
	export let onDeleteFromGooglePhotos: () => void;
	export let onRegroup: () => void;
	export let onReindex: () => void;
	export let onRescan: () => void;
	export let getCachedBlobUrl: (photo: Photo) => string;
	export let getGroupPhotos: (group: Group) => Promise<Photo[]>;

	// Auto-select props
	export let autoSelectStatus:
		| 'idle'
		| 'payment'
		| 'ready'
		| 'uploading'
		| 'processing'
		| 'completed'
		| 'failed' = 'idle';
	export let autoSelectProgress: number = 0;
	export let autoSelectError: string = '';
	export let onAutoSelect: () => void;
	export let onCheckoutCreated: (checkoutUrl: string, jobId: string) => void;
	export let onStartUpload: () => void;
	export let totalPhotosCount: number = 0;

	let showPaymentModal = false;

	function handleAutoSelect() {
		showPaymentModal = true;
		onAutoSelect();
	}

	function handleCheckoutCreated(checkoutUrl: string, jobId: string) {
		showPaymentModal = false;
		onCheckoutCreated(checkoutUrl, jobId);
	}
</script>

{#if displayGroups.length === 0 && ungroupedPhotos.length === 0}
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
	<div>
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
		{:else if autoSelectStatus === 'failed'}
			<AutoSelectProcessingBanner status="failed" uploadProgress={0} message={autoSelectError} />
		{/if}

		{#if displayGroups.length > 0}
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
							Found {displayGroups.length} duplicate groups
						</h2>
						<p class="text-lg font-semibold text-brutalist-gray">
							Click photos to mark for deletion
						</p>
					</div>
				</div>
				<div class="flex flex-wrap gap-3">
					<!-- Auto-select button (shown when idle) -->
					{#if autoSelectStatus === 'idle' && selectedPhotos.size === 0}
						<button
							onclick={handleAutoSelect}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-gradient-to-r from-purple-500 to-pink-500 px-6 py-3 text-lg font-black whitespace-nowrap text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
						>
							🤖 Auto Select
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

					{#if selectedPhotos.size > 0}
						<button
							onclick={onClearSelection}
							class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-purple-200 px-6 py-3 font-bold whitespace-nowrap text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
							disabled={autoSelectStatus === 'uploading'}
						>
							Clear ({selectedPhotos.size})
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
				{#each displayGroups as group (group.id)}
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
							{selectedPhotos}
							{onToggleSelection}
							{onSelectAllInGroup}
							{getCachedBlobUrl}
						/>
					{/await}
				{/each}
			</div>
		{/if}

		<!-- Ungrouped Photos -->
		{#if ungroupedPhotos.length > 0}
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
