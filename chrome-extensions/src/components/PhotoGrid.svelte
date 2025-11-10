<script lang="ts">
	import type { Photo } from '../lib/db';

	export let photos: Photo[];
	export let getCachedBlobUrl: (photo: Photo) => string;
	export let selectable = false;
	export let selectedPhotos: Set<string> = new Set();
	export let onToggleSelection: ((photoId: string) => void) | undefined = undefined;
</script>

<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
	{#each photos as photo (photo.id)}
		{#if selectable && onToggleSelection}
			<button
				class="relative aspect-square cursor-pointer overflow-hidden rounded-xl border-4 bg-none p-0 transition-all"
				class:border-red-500={selectedPhotos.has(photo.id)}
				class:border-transparent={!selectedPhotos.has(photo.id)}
				class:shadow-brutalist-sm={!selectedPhotos.has(photo.id)}
				class:hover:scale-105={true}
				class:hover:shadow-brutalist={true}
				onclick={() => onToggleSelection(photo.id)}
				type="button"
			>
				<img
					src={getCachedBlobUrl(photo)}
					alt=""
					loading="lazy"
					class="h-full w-full object-cover"
				/>
				{#if selectedPhotos.has(photo.id)}
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
			</button>
		{:else}
			<div class="aspect-square overflow-hidden rounded-xl border-2 border-black bg-gray-100">
				<img
					src={getCachedBlobUrl(photo)}
					alt=""
					loading="lazy"
					class="h-full w-full object-cover"
				/>
			</div>
		{/if}
	{/each}
</div>
