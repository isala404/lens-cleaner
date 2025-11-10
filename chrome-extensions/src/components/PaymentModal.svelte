<script lang="ts">
	import { createCheckout } from '../lib/api';

	export let show: boolean;
	export let photoCount: number;
	export let onClose: () => void;
	export let onCheckoutCreated: (checkoutUrl: string, jobId: string) => void;

	let email = '';
	let isSubmitting = false;
	let error = '';

	const PRICE_PER_PHOTO = 0.01;
	$: totalCost = photoCount * PRICE_PER_PHOTO;

	async function handlePay() {
		if (!email) {
			error = 'Please enter your email';
			return;
		}

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			error = 'Please enter a valid email';
			return;
		}

		try {
			isSubmitting = true;
			error = '';

			const response = await createCheckout(email, photoCount);

			// Extract job_id from checkout URL
			// The backend will redirect back with job_id as a URL parameter
			// For now, we'll extract it from the checkout_id
			const jobId = response.checkout_id; // This will be updated when payment completes

			onCheckoutCreated(response.checkout_url, jobId);
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
			class="shadow-brutalist-lg relative w-full max-w-2xl animate-slide-in rounded-2xl border-4 border-black bg-white p-8"
		>
			<!-- Close Button -->
			<button
				onclick={onClose}
				class="absolute right-4 top-4 text-3xl font-black text-gray-400 transition-colors hover:text-black"
				aria-label="Close"
			>
				×
			</button>

			<!-- Header -->
			<div class="mb-6 text-center">
				<div class="mb-4 text-6xl">🎯</div>
				<h2 class="mb-2 text-4xl font-black text-black">AI-Powered Auto Select</h2>
				<p class="text-lg font-semibold text-gray-600">Let AI choose the best photos to keep</p>
			</div>

			<!-- Value Proposition -->
			<div class="mb-6 space-y-4 rounded-xl border-4 border-black bg-gradient-to-br from-purple-50 to-pink-50 p-6">
				<h3 class="text-xl font-black text-black">What you get:</h3>
				<ul class="space-y-3">
					<li class="flex items-start gap-3">
						<span class="text-2xl">🤖</span>
						<div>
							<p class="font-bold text-black">Smart Analysis</p>
							<p class="text-sm text-gray-600">
								Powered by Google Gemini AI to identify duplicates and low-quality photos
							</p>
						</div>
					</li>
					<li class="flex items-start gap-3">
						<span class="text-2xl">⚡</span>
						<div>
							<p class="font-bold text-black">Save Time</p>
							<p class="text-sm text-gray-600">
								No more manual selection - AI does the heavy lifting in hours
							</p>
						</div>
					</li>
					<li class="flex items-start gap-3">
						<span class="text-2xl">✨</span>
						<div>
							<p class="font-bold text-black">Keep the Best</p>
							<p class="text-sm text-gray-600">
								Preserves photos with artistic merit, genuine emotions, and unique moments
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
						<span class="font-semibold text-gray-700">Photos to analyze:</span>
						<span class="text-xl font-black text-black">{photoCount}</span>
					</div>
					<div class="flex items-center justify-between">
						<span class="font-semibold text-gray-700">Price per photo:</span>
						<span class="font-mono text-lg font-bold text-black">${PRICE_PER_PHOTO.toFixed(2)}</span>
					</div>
				</div>
				<div class="border-t-4 border-black pt-4">
					<div class="flex items-center justify-between">
						<span class="text-lg font-black text-gray-900">Total Cost:</span>
						<span class="text-3xl font-black text-black">${totalCost.toFixed(2)}</span>
					</div>
				</div>
			</div>

			<!-- Email Input -->
			<div class="mb-6">
				<label for="email" class="mb-2 block text-sm font-bold text-gray-700">
					Email for receipt:
				</label>
				<input
					type="email"
					id="email"
					bind:value={email}
					placeholder="your@email.com"
					class="w-full rounded-lg border-4 border-black px-4 py-3 font-mono text-lg focus:outline-none focus:ring-4 focus:ring-purple-300"
					disabled={isSubmitting}
				/>
			</div>

			<!-- Error Message -->
			{#if error}
				<div class="mb-4 rounded-lg border-2 border-red-500 bg-red-50 p-3 text-center text-sm font-semibold text-red-700">
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
					{isSubmitting ? '⏳ Processing...' : '💳 Proceed to Payment'}
				</button>
			</div>

			<!-- Support -->
			<p class="mt-4 text-center text-xs text-gray-500">
				Need help? Contact <a href="mailto:support@tallisa.dev" class="font-semibold text-purple-600 hover:underline">support@tallisa.dev</a>
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
