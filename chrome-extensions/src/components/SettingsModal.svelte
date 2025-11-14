<script lang="ts">
	export let showSettings: boolean;
	export let editingSettings: {
		similarityThreshold: number;
		timeWindowMinutes: number;
		windowSizeMinutes: number;
		overlapMinutes: number;
		minGroupSize: number;
	};
	export let similaritySliderPosition: number;
	export let onClose: () => void;
	export let onSave: () => void;
	export let onSliderChange: (value: number) => void;
</script>

{#if showSettings}
	<div
		class="fixed top-0 left-0 z-1000 flex h-full w-full items-center justify-center bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) {
				onClose();
			}
		}}
		onkeydown={(e) => e.key === 'Escape' && onClose()}
	>
		<div
			class="cozy-card shadow-brutalist-lg max-h-[90vh] w-[90%] max-w-2xl overflow-y-auto"
			role="document"
		>
			<div class="flex items-center justify-between border-b-4 border-black p-6">
				<h2 id="settings-title" class="text-3xl font-black text-black">⚙️ Settings</h2>
				<button
					class="h-8 w-8 cursor-pointer border-none bg-none p-0 text-5xl leading-none text-gray-400 transition-colors hover:text-gray-800"
					onclick={onClose}
				>
					&times;
				</button>
			</div>
			<div class="p-6">
				<div class="mb-8">
					<label for="similarityThreshold" class="mb-3 flex flex-col gap-1">
						<strong class="text-lg text-black">Match Sensitivity</strong>
						<span class="text-sm font-medium text-brutalist-gray"
							>How similar photos need to be</span
						>
					</label>
					<div class="mb-2 flex items-center gap-3">
						<span class="min-w-[50px] text-sm font-semibold text-brutalist-gray">Loose</span>
						<input
							type="range"
							id="similarityThreshold"
							bind:value={similaritySliderPosition}
							oninput={(e) => onSliderChange(Number((e.target as HTMLInputElement).value))}
							min="0"
							max="100"
							step="1"
							class="h-2 flex-1 appearance-none rounded-full border-2 border-black bg-gray-200 outline-none [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-black [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-black"
						/>
						<span class="min-w-[50px] text-sm font-semibold text-brutalist-gray">Strict</span>
					</div>
					<span class="mb-1 block text-sm font-bold text-black"
						>{similaritySliderPosition}% match required</span
					>
					<span class="text-sm text-brutalist-gray"
						>Lower values group more photos together (default: 70%)</span
					>
				</div>

				<div class="mb-8">
					<label for="timeWindow" class="mb-3 flex flex-col gap-1">
						<strong class="text-lg text-black">Time Window</strong>
						<span class="text-sm font-medium text-brutalist-gray"
							>Photos taken within this time can be grouped</span
						>
					</label>
					<input
						type="number"
						id="timeWindow"
						bind:value={editingSettings.timeWindowMinutes}
						min="5"
						max="1440"
						step="5"
						class="mb-1 w-full rounded-xl border-4 border-black p-2.5 text-sm font-semibold focus:ring-4 focus:ring-pastel-purple-200 focus:outline-none"
					/>
					<span class="mb-1 block text-sm text-brutalist-gray">minutes</span>
					<span class="text-sm text-brutalist-gray"
						>Photos taken within this time window can be grouped (default: 60 minutes)</span
					>
				</div>

				<div class="mb-8">
					<label for="windowSize" class="mb-3 flex flex-col gap-1">
						<strong class="text-lg text-black">Memory Window Size</strong>
						<span class="text-sm font-medium text-brutalist-gray"
							>Amount of photos loaded into memory at once</span
						>
					</label>
					<input
						type="number"
						id="windowSize"
						bind:value={editingSettings.windowSizeMinutes}
						min="10"
						max="1440"
						step="10"
						class="mb-1 w-full rounded-xl border-4 border-black p-2.5 text-sm font-semibold focus:ring-4 focus:ring-pastel-purple-200 focus:outline-none"
					/>
					<span class="mb-1 block text-sm text-brutalist-gray">minutes</span>
					<span class="text-sm text-brutalist-gray"
						>Smaller windows use less memory but may miss connections (default: 60 minutes)</span
					>
				</div>

				<div class="mb-8">
					<label for="overlap" class="mb-3 flex flex-col gap-1">
						<strong class="text-lg text-black">Window Overlap</strong>
						<span class="text-sm font-medium text-brutalist-gray"
							>Overlap between consecutive memory windows</span
						>
					</label>
					<input
						type="number"
						id="overlap"
						bind:value={editingSettings.overlapMinutes}
						min="0"
						max="720"
						step="5"
						class="mb-1 w-full rounded-xl border-4 border-black p-2.5 text-sm font-semibold focus:ring-4 focus:ring-pastel-purple-200 focus:outline-none"
					/>
					<span class="mb-1 block text-sm text-brutalist-gray">minutes</span>
					<span class="text-sm text-brutalist-gray"
						>Ensures photos near window boundaries are connected (default: 30 minutes)</span
					>
				</div>

				<div class="mb-0">
					<label for="minGroupSize" class="mb-3 flex flex-col gap-1">
						<strong class="text-lg text-black">Minimum Photos per Group</strong>
						<span class="text-sm font-medium text-brutalist-gray"
							>Only show groups with at least this many photos</span
						>
					</label>
					<input
						type="number"
						id="minGroupSize"
						bind:value={editingSettings.minGroupSize}
						min="2"
						max="10"
						class="mb-1 w-full rounded-xl border-4 border-black p-2.5 text-sm font-semibold focus:ring-4 focus:ring-pastel-purple-200 focus:outline-none"
					/>
					<span class="text-sm text-brutalist-gray">photos</span>
				</div>
			</div>
			<div class="flex justify-end gap-3 border-t-4 border-black p-6">
				<button
					class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-pastel-purple-200 px-6 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
					onclick={onClose}
				>
					Cancel
				</button>
				<button
					class="shadow-brutalist hover:shadow-brutalist-lg rounded-xl border-4 border-black bg-linear-to-br from-pastel-pink-200 to-pastel-pink-300 px-6 py-3 font-black text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
					onclick={onSave}
				>
					Save
				</button>
			</div>
		</div>
	</div>
{/if}
