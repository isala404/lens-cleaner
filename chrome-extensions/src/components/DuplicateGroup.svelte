<script lang="ts">
	import type { Photo, Group } from '../lib/db';
	import PhotoGrid from './PhotoGrid.svelte';

	export let group: Group;
	export let photos: Photo[];
	export let onToggleSelection: (photoId: string) => void;
	export let onSelectAllInGroup: (groupId: string) => void;
	export let getCachedBlobUrl: (photo: Photo) => string;
</script>

<div
	class="organic-texture cozy-card shadow-brutalist hover:shadow-brutalist-lg p-6 transition-all hover:border-black"
>
	<div class="mb-5 flex items-center justify-between">
		<h3 class="text-2xl font-black text-black">
			Duplicate Group ({photos.length} photos)
		</h3>
		<button
			onclick={() => onSelectAllInGroup(group.id)}
			class="cursor-pointer border-none bg-none px-2 py-1 text-sm font-bold text-black hover:underline"
		>
			Select All
		</button>
	</div>
	<PhotoGrid {photos} {getCachedBlobUrl} selectable={true} {onToggleSelection} />
</div>
