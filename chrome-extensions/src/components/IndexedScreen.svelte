<script lang="ts">
	import type { Photo } from '../lib/db';
	import PhotoGrid from './PhotoGrid.svelte';

	export let photosWithEmbeddings: number;
	export const photos: Photo[] = []; // Legacy prop, not used anymore
	export let onStartGrouping: () => void;
	export let onReindex: () => void;
	export let onOpenSettings: () => void;
	export let getCachedBlobUrl: (photo: Photo) => string;
</script>

<div class="p-5">
	<div class="mb-8 flex items-start justify-between border-b-4 border-black pb-6">
		<div class="flex flex-col gap-3">
			<button
				onclick={onReindex}
				class="self-start rounded-lg border-2 border-black bg-gray-200 px-4 py-2 text-sm font-bold text-brutalist-gray transition-all hover:bg-gray-300"
			>
				← Reindex
			</button>
			<div>
				<h2 class="mb-2 text-4xl font-black text-black">
					✅ {photosWithEmbeddings} Photos Indexed
				</h2>
				<p class="text-lg font-semibold text-brutalist-gray">
					Ready to find duplicates. Adjust settings if needed before grouping.
				</p>
			</div>
		</div>
		<div class="flex gap-3">
			<button
				onclick={onStartGrouping}
				class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-linear-to-br from-pastel-blue-200 to-pastel-blue-300 px-6 py-3 text-lg font-black text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
			>
				🔍 Start Grouping
			</button>
			<button
				onclick={onOpenSettings}
				class="flex items-center justify-center rounded-xl border-4 border-black bg-pastel-purple-100 px-4 py-3 text-2xl transition-all hover:bg-pastel-purple-200"
			>
				⚙️
			</button>
		</div>
	</div>

	<!-- Use pagination mode for PhotoGrid -->
	<PhotoGrid {getCachedBlobUrl} enablePagination={true} totalPhotos={photosWithEmbeddings} />
</div>
