<script lang="ts">
	export let currentStep: 'welcome' | 'preview' | 'indexing' | 'indexed' | 'grouping' | 'reviewing';
</script>

<div class="mb-14 flex items-center justify-center px-5">
	<div class="flex flex-col items-center gap-2">
		<div
			class="flex h-16 w-16 items-center justify-center rounded-full border-4 border-black text-2xl font-black transition-all duration-300"
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
		class="mx-1 h-1 w-20 transition-all duration-300"
		class:bg-emerald-400={currentStep === 'indexing' ||
			currentStep === 'indexed' ||
			currentStep === 'grouping' ||
			currentStep === 'reviewing'}
		class:bg-gray-300={currentStep === 'welcome' || currentStep === 'preview'}
	></div>
	<div class="flex flex-col items-center gap-2">
		<div
			class="flex h-16 w-16 items-center justify-center rounded-full border-4 border-black text-2xl font-black transition-all duration-300"
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
		class="mx-1 h-1 w-20 transition-all duration-300"
		class:bg-emerald-400={currentStep === 'indexed' ||
			currentStep === 'grouping' ||
			currentStep === 'reviewing'}
		class:bg-gray-300={currentStep === 'welcome' ||
			currentStep === 'preview' ||
			currentStep === 'indexing'}
	></div>
	<div class="flex flex-col items-center gap-2">
		<div
			class="flex h-16 w-16 items-center justify-center rounded-full border-4 border-black text-2xl font-black transition-all duration-300"
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
		class="mx-1 h-1 w-20 transition-all duration-300"
		class:bg-emerald-400={currentStep === 'reviewing'}
		class:bg-gray-300={currentStep !== 'reviewing'}
	></div>
	<div class="flex flex-col items-center gap-2">
		<div
			class="flex h-16 w-16 items-center justify-center rounded-full border-4 border-black text-2xl font-black transition-all duration-300"
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
