<script lang="ts">
	import type { Photo } from '../lib/db';
	import PhotoGrid from './PhotoGrid.svelte';

	export let totalPhotos: number;
	export let photos: Photo[];
	export let onStartIndexing: () => void;
	export let getCachedBlobUrl: (photo: Photo) => string;
</script>

<div class="p-5">
	<div class="mb-8 flex items-start justify-between border-b-4 border-black pb-6">
		<div>
			<h2 class="mb-2 text-4xl font-black text-black">
				📷 {totalPhotos} Photos Scanned
			</h2>
			<p class="text-lg font-semibold text-brutalist-gray">
				Review your scanned photos before indexing
			</p>
		</div>
		<div class="flex gap-3">
			<button
				onclick={onStartIndexing}
				class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-linear-to-br from-pastel-pink-200 to-pastel-pink-300 px-6 py-3 text-lg font-black text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
			>
				🧠 Start Indexing
			</button>
		</div>
	</div>

	<PhotoGrid {photos} {getCachedBlobUrl} />
</div>
