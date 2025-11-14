<script lang="ts">
	export let currentStep: 'indexing' | 'grouping';
	export let totalPhotos: number;
	export let photosWithEmbeddings: number;
	export let totalGroups: number;
	export let processingProgress: {
		isProcessing: boolean;
		current: number;
		total: number;
		message: string;
	};
	export let estimatedTimeRemaining: number;
	export let formatTimeEstimate: (ms: number) => string;
</script>

<div class="px-2.5 py-5 text-center">
	<div
		class="mx-auto mb-8 h-16 w-16 animate-spin rounded-full border-4 border-gray-300 border-t-black"
	></div>
	<h2 class="mb-3 text-4xl font-black text-black">
		{#if currentStep === 'indexing'}
			🧠 Indexing your photos...
		{:else}
			🔍 Finding duplicates...
		{/if}
	</h2>
	<p class="mb-10 text-lg font-medium text-brutalist-gray">
		{#if processingProgress.message}
			{processingProgress.message}
		{:else}
			This may take a few moments. We're using AI to compare your photos.
		{/if}
	</p>

	<div class="mx-auto mb-8 grid max-w-lg grid-cols-2 gap-5">
		<div class="shadow-brutalist-sm rounded-2xl border-4 border-black bg-pastel-pink-100 p-6">
			<div class="mb-2 text-5xl font-black text-black">
				{#if currentStep === 'grouping' && processingProgress.isProcessing}
					{processingProgress.current}
				{:else}
					{totalPhotos}
				{/if}
			</div>
			<div class="text-sm font-bold tracking-wide text-brutalist-gray uppercase">
				{#if currentStep === 'indexing'}
					Photos Scanned
				{:else if currentStep === 'grouping'}
					Photos Processed
				{:else}
					Photos Indexed
				{/if}
			</div>
		</div>
		<div class="shadow-brutalist-sm rounded-2xl border-4 border-black bg-pastel-purple-100 p-6">
			<div class="mb-2 text-5xl font-black text-black">
				{#if processingProgress.isProcessing}
					{#if currentStep === 'grouping'}
						{totalGroups}
					{:else}
						{processingProgress.current}
					{/if}
				{:else if currentStep === 'indexing'}
					{photosWithEmbeddings}
				{:else}
					{totalGroups}
				{/if}
			</div>
			<div class="text-sm font-bold tracking-wide text-brutalist-gray uppercase">
				{#if currentStep === 'indexing'}
					Photos Analyzed
				{:else}
					Groups Found
				{/if}
			</div>
		</div>
	</div>

	{#if processingProgress.isProcessing && processingProgress.total > 0}
		<div class="mx-auto mt-8 max-w-2xl">
			<div class="mb-3 flex items-center gap-3">
				<span class="min-w-[60px] text-2xl font-black text-black">
					{Math.floor((processingProgress.current / processingProgress.total) * 100)}%
				</span>
				<div class="h-4 flex-1 overflow-hidden rounded-md border-2 border-black bg-gray-200">
					<div
						class="h-full bg-linear-to-r from-pastel-pink-300 to-pastel-purple-300 transition-all duration-300"
						style="width: {(processingProgress.current / processingProgress.total) * 100}%"
					></div>
				</div>
			</div>
			<div class="flex items-center justify-end">
				{#if estimatedTimeRemaining > 0}
					<span class="text-sm font-bold text-black">
						~{formatTimeEstimate(estimatedTimeRemaining)} remaining
					</span>
				{/if}
			</div>
		</div>
	{/if}

	<div
		class="shadow-brutalist-sm mt-12 inline-flex max-w-3xl items-center gap-2.5 rounded-2xl border-4 border-black bg-pastel-blue-100 px-6 py-4"
	>
		<span class="shrink-0 text-2xl">💡</span>
		<span class="text-sm leading-relaxed font-semibold text-black"
			>Keep this tab in focus otherwise the browser would suspend the operation.</span
		>
	</div>
</div>
