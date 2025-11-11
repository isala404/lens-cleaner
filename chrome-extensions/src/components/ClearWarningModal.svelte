<script lang="ts">
	export let show: boolean;
	export let onClose: () => void;
	export let onConfirm: () => void;
	export let selectedCount: number = 0;

	let confirmText = '';
	$: isConfirmValid = confirmText.toLowerCase() === 'i understand';

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			onClose();
		}
	}
</script>

{#if show}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={handleBackdropClick}
		onkeydown={(e) => e.key === 'Escape' && onClose()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="shadow-brutalist-lg animate-slide-in relative w-full max-w-md rounded-2xl border-4 border-black bg-white p-8"
		>
			<!-- Close Button -->
			<button
				onclick={onClose}
				class="absolute top-4 right-4 text-3xl font-black text-gray-400 transition-colors hover:text-black"
				aria-label="Close"
			>
				×
			</button>

			<!-- Header -->
			<div class="mb-6 text-center">
				<div class="mb-4 text-6xl">🧹</div>
				<h2 class="mb-2 text-3xl font-black text-black">Clear Selection?</h2>
			</div>

			<!-- Warning Message -->
			<div class="mb-6 space-y-4">
				<p class="text-lg font-semibold text-gray-800">
					You are about to clear your selection of <span class="font-black text-red-600"
						>{selectedCount} photo(s)</span
					>.
				</p>

				<div class="rounded-lg border-2 border-orange-500 bg-orange-50 p-4">
					<p class="mb-2 font-bold text-orange-800">
						This will remove all AI suggestions and your current selection.
					</p>
					<p class="text-sm text-orange-700">
						You will need to use auto-select again if you want AI recommendations.
					</p>
				</div>

				<p class="text-sm text-gray-600">
					Type <span class="font-mono font-bold">"I understand"</span> below to proceed:
				</p>

				<input
					type="text"
					bind:value={confirmText}
					placeholder="I understand"
					class="w-full rounded-lg border-4 border-black px-4 py-3 font-mono text-lg focus:ring-4 focus:ring-orange-300 focus:outline-none"
				/>
			</div>

			<!-- Actions -->
			<div class="flex gap-3">
				<button
					onclick={onClose}
					class="shadow-brutalist hover:shadow-brutalist-lg flex-1 rounded-xl border-4 border-black bg-gray-200 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
				>
					Cancel
				</button>
				<button
					onclick={onConfirm}
					disabled={!isConfirmValid}
					class="shadow-brutalist hover:shadow-brutalist-lg flex-1 rounded-xl border-4 border-black bg-orange-500 py-3 font-black text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] disabled:cursor-not-allowed disabled:opacity-50"
				>
					Clear Selection
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(-20px) scale(0.95);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.animate-slide-in {
		animation: slideIn 0.3s ease-out;
	}
</style>
