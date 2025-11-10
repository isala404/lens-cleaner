<script lang="ts">
	import type { Photo } from '../lib/db';

	export let photos: Photo[];
	export let getCachedBlobUrl: (photo: Photo) => string;
	export let selectable = false;
	export let selectedPhotos: Set<string> = new Set();
	export let onToggleSelection: ((photoId: string) => void) | undefined = undefined;

	let hoveredPhotoId: string | null = null;


<div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
	{#each photos as photo (photo.id)}
		{#if selectable && onToggleSelection}
			<div class="relative">
				<button
					class="relative aspect-square w-full cursor-pointer overflow-hidden rounded-xl border-4 bg-none p-0 transition-all"
					class:border-red-500={selectedPhotos.has(photo.id)}
					class:border-transparent={!selectedPhotos.has(photo.id)}
					class:shadow-brutalist-sm={!selectedPhotos.has(photo.id)}
					class:hover:scale-105={true}
					class:hover:shadow-brutalist={true}
					onclick={() => onToggleSelection(photo.id)}
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

					<!-- AI Suggestion Badge -->
					{#if photo.aiSuggestionReason}
						<div class="absolute right-2 top-2">
							<div
								class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-black bg-gradient-to-br from-purple-400 to-pink-400 text-sm font-black text-white shadow-lg"
								title="AI Suggested"
							>
								🤖
							</div>
						</div>
					{/if}
				</button>

				<!-- AI Tooltip -->
				{#if photo.aiSuggestionReason && hoveredPhotoId === photo.id}
					<div
						class="absolute left-1/2 bottom-full z-50 mb-2 w-64 -translate-x-1/2 rounded-lg border-4 border-black bg-white p-3 shadow-brutalist-lg"
					>
						<div class="mb-2 flex items-center gap-2">
							<span class="text-lg">🤖</span>
							<span class="text-xs font-black text-purple-600">AI SUGGESTION</span>
							{#if photo.aiSuggestionConfidence}
								<span
									class="ml-auto rounded-full px-2 py-0.5 text-xs font-bold"
									class:bg-red-100={photo.aiSuggestionConfidence === 'high'}
									class:bg-yellow-100={photo.aiSuggestionConfidence === 'medium'}
									class:bg-blue-100={photo.aiSuggestionConfidence === 'low'}
									class:text-red-800={photo.aiSuggestionConfidence === 'high'}
									class:text-yellow-800={photo.aiSuggestionConfidence === 'medium'}
									class:text-blue-800={photo.aiSuggestionConfidence === 'low'}
								>
									{photo.aiSuggestionConfidence}
								</span>
							{/if}
						</div>
						<p class="text-sm font-semibold text-gray-800">{photo.aiSuggestionReason}</p>
					</div>
				{/if}
			</div>
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
