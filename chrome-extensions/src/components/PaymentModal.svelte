<script lang="ts">
	import { createCheckout } from '../lib/api';

	export let show: boolean;
	export let photoCount: number;
	export let onClose: () => void;
	export let onCheckoutCreated: (checkoutUrl: string, checkoutId: string, jobId: string) => void;

	let isSubmitting = false;
	let error = '';

	const PRICE_PER_PHOTO = 0.01;
	const PHOTOS_PER_UNIT = 100;

	// Calculate pricing with rounding
	$: isFree = photoCount < 100;
	$: chargedPhotos = isFree ? 0 : Math.floor(photoCount / PHOTOS_PER_UNIT) * PHOTOS_PER_UNIT;
	$: totalCost = chargedPhotos * PRICE_PER_PHOTO;
	$: bonusPhotos = photoCount - chargedPhotos;

	async function handlePay() {
		try {
			isSubmitting = true;
			error = '';

			const response = await createCheckout(photoCount);

			// Save checkout info before navigating
			onCheckoutCreated(response.checkout_url, response.checkout_id, response.job_id);

			// Navigate to Polar checkout page
			window.location.href = response.checkout_url;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create checkout';
			isSubmitting = false;
		}
	}

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
		role="dialog"
		aria-modal="true"
	>
		<div
			class="shadow-brutalist-lg animate-slide-in relative w-full max-w-2xl rounded-2xl border-4 border-black bg-white p-8"
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
				<div class="mb-4 text-6xl">🎯</div>
				<h2 class="mb-2 text-4xl font-black text-black">AI-Powered Auto Select</h2>
				<p class="text-lg font-semibold text-gray-600">
					{isFree ? 'Free analysis for under 100 photos!' : 'Let AI choose the best photos to keep'}
				</p>
			</div>

			<!-- Info Section -->
			<div
				class="mb-6 space-y-4 rounded-xl border-4 border-black bg-gradient-to-br from-purple-50 to-pink-50 p-6"
			>
				<h3 class="text-xl font-black text-black">How it works:</h3>
				<ul class="space-y-3">
					<li class="flex items-start gap-3">
						<span class="text-2xl">📸</span>
						<div>
							<p class="font-bold text-black">Photo Analysis</p>
							<p class="text-sm text-gray-600">
								You have <strong>{photoCount}</strong> photos ready to analyze
							</p>
						</div>
					</li>
					<li class="flex items-start gap-3">
						<span class="text-2xl">⏱️</span>
						<div>
							<p class="font-bold text-black">Time-Consuming Process</p>
							<p class="text-sm text-gray-600">
								Manual selection takes hours. Let our AI do it for you automatically!
							</p>
						</div>
					</li>
					<li class="flex items-start gap-3">
						<span class="text-2xl">🤖</span>
						<div>
							<p class="font-bold text-black">Smart AI Analysis</p>
							<p class="text-sm text-gray-600">
								Powered by Google Gemini to identify duplicates and low-quality photos while
								preserving your best memories
							</p>
						</div>
					</li>
					<li class="flex items-start gap-3">
						<span class="text-2xl">💡</span>
						<div>
							<p class="font-bold text-black">Detailed Explanations</p>
							<p class="text-sm text-gray-600">
								See why each photo was suggested for deletion with AI-generated reasons
							</p>
						</div>
					</li>
				</ul>
			</div>

			<!-- Pricing -->
			<div class="mb-6 rounded-xl border-4 border-black bg-gray-50 p-6">
				<div class="mb-4 space-y-2">
					<div class="flex items-center justify-between">
						<span class="font-semibold text-gray-700">Total photos to analyze:</span>
						<span class="text-xl font-black text-black">{photoCount}</span>
					</div>
					{#if !isFree}
						<div class="flex items-center justify-between">
							<span class="font-semibold text-gray-700">Charged for:</span>
							<span class="font-mono text-lg font-bold text-black">{chargedPhotos} photos</span>
						</div>
						{#if bonusPhotos > 0}
							<div
								class="flex items-center justify-between rounded-lg border-2 border-yellow-400 bg-yellow-50 p-2"
							>
								<span class="font-semibold text-yellow-800">🎉 Bonus photos:</span>
								<span class="font-mono text-lg font-bold text-yellow-900">{bonusPhotos} FREE</span>
							</div>
						{/if}
						<div class="flex items-center justify-between">
							<span class="font-semibold text-gray-700">Price per photo:</span>
							<span class="font-mono text-sm font-bold text-gray-600"
								>${PRICE_PER_PHOTO.toFixed(2)}</span
							>
						</div>
					{/if}
				</div>
				<div class="border-t-4 border-black pt-4">
					<div class="flex items-center justify-between">
						<span class="text-lg font-black text-gray-900">Total Cost:</span>
						<span class="text-3xl font-black text-black">
							{#if isFree}
								FREE
							{:else}
								${totalCost.toFixed(2)}
							{/if}
						</span>
					</div>
				</div>
			</div>

			{#if !isFree}
				<!-- Payment Info -->
				<div class="mb-6 rounded-lg border-2 border-purple-200 bg-purple-50 p-4">
					<p class="text-center text-sm font-semibold text-purple-900">
						💳 Payment will be processed securely by Polar. No email needed - handled during
						checkout.
					</p>
				</div>
			{/if}

			<!-- Error Message -->
			{#if error}
				<div
					class="mb-4 rounded-lg border-2 border-red-500 bg-red-50 p-3 text-center text-sm font-semibold text-red-700"
				>
					{error}
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex gap-3">
				<button
					onclick={onClose}
					disabled={isSubmitting}
					class="shadow-brutalist hover:shadow-brutalist-lg flex-1 rounded-xl border-4 border-black bg-gray-200 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={handlePay}
					disabled={isSubmitting}
					class="shadow-brutalist hover:shadow-brutalist-lg flex-1 rounded-xl border-4 border-black bg-gradient-to-r from-purple-500 to-pink-500 py-3 font-black text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] disabled:opacity-50"
				>
					{#if isSubmitting}
						⏳ Processing...
					{:else if isFree}
						🎉 Start Free Analysis
					{:else}
						💳 Proceed to Payment
					{/if}
				</button>
			</div>

			<!-- Support -->
			<p class="mt-4 text-center text-xs text-gray-500">
				Need help? Contact <a
					href="mailto:support@tallisa.dev"
					class="font-semibold text-purple-600 hover:underline">support@tallisa.dev</a
				>
			</p>
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
