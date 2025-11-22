<script lang="ts">
	/* eslint-disable svelte/infinite-reactive-loop */
	import { createCheckout, calculatePricing } from '../lib/api';

	export let show: boolean;
	export let photoCount: number;
	export let onClose: () => void;
	export let onCheckoutCreated: (
		checkoutUrl: string,
		checkoutId: string,
		jobId: string,
		amount: number
	) => void;

	let isSubmitting = false;
	let isLoadingPricing = false;
	let error = '';

	// Pricing state
	let isFree = true;
	let chargedPhotos = 0;
	let totalCost = 0;
	let pricingLoaded = false;
	let hasStartedLoading = false;
	let volumeLimited = false;
	let volumeLimit = 0;
	let salesEmail = '';

	// Reset pricing state when modal closes
	$: if (!show) {
		pricingLoaded = false;
		isLoadingPricing = false;
		error = '';
		hasStartedLoading = false;
	}

	// Load pricing when modal opens
	import { onMount } from 'svelte';

	onMount(() => {
		return () => {
			// Cleanup on unmount
			pricingLoaded = false;
			isLoadingPricing = false;
			error = '';
			hasStartedLoading = false;
		};
	});

	// Watch for show changes
	$: {
		if (show && photoCount > 0 && !pricingLoaded && !hasStartedLoading) {
			hasStartedLoading = true;
			loadPricing();
		}
	}

	async function loadPricing() {
		try {
			isLoadingPricing = true;
			error = '';
			const pricing = await calculatePricing(photoCount);
			isFree = pricing.is_free;
			chargedPhotos = pricing.charged_photos;
			totalCost = pricing.total_cost;
			volumeLimited = pricing.volume_limited || false;
			volumeLimit = pricing.volume_limit || 0;
			salesEmail = pricing.sales_email || '';
			pricingLoaded = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to calculate pricing';
		} finally {
			isLoadingPricing = false;
		}
	}

	async function handlePay() {
		try {
			isSubmitting = true;
			error = '';

			const response = await createCheckout(photoCount);

			// Save checkout info before navigating
			onCheckoutCreated(response.checkout_url, response.checkout_id, response.job_id, totalCost);

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

	function handleBackdropKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			onClose();
		}
	}
</script>

{#if show}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={handleBackdropClick}
		onkeydown={handleBackdropKeydown}
		role="dialog"
		aria-modal="true"
		tabindex="0"
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
					{isFree
						? 'Free analysis for 50 photos or less!'
						: 'Let AI choose the best photos to keep'}
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
								Identify duplicates and low-quality photos while preserving your best memories
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

			<!-- Volume Limit Warning -->
			{#if pricingLoaded && volumeLimited}
				<div class="mb-6 rounded-xl border-4 border-red-500 bg-red-50 p-6">
					<div class="mb-4 flex items-center gap-3">
						<div
							class="flex h-12 w-12 items-center justify-center rounded-full bg-red-500 text-2xl"
						>
							🚫
						</div>
						<div>
							<h3 class="text-xl font-black text-black">Volume Limit Exceeded</h3>
							<p class="text-sm font-semibold text-gray-700">
								You have {photoCount} photos, which exceeds our standard limit of {volumeLimit} photos
							</p>
						</div>
					</div>

					<div class="mb-4 space-y-2">
						<p class="font-semibold text-gray-800">
							For processing more than {volumeLimit} photos, please contact our sales team for a volume
							discount:
						</p>
						<div class="flex items-center justify-center">
							<a
								href="mailto:{salesEmail}"
								class="shadow-brutalist hover:shadow-brutalist-lg inline-flex items-center gap-2 rounded-xl border-4 border-black bg-red-500 px-6 py-3 font-bold text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
							>
								📧 Contact Sales: {salesEmail}
							</a>
						</div>
					</div>

					<p class="text-center text-sm text-gray-600">
						Our sales team will help you with bulk processing options and special pricing
					</p>
				</div>
			{:else}
				<!-- Pricing -->
				<div class="mb-6 rounded-xl border-4 border-black bg-gray-50 p-6">
					{#if isLoadingPricing}
						<div class="flex items-center justify-center py-8">
							<div
								class="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-black"
							></div>
							<span class="ml-3 font-semibold text-gray-700">Calculating pricing...</span>
						</div>
					{:else}
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
					{/if}
				</div>
			{/if}

			{#if !isFree}
				<!-- Amount Warning -->
				<div class="mb-6 rounded-lg border-2 border-red-400 bg-red-50 p-4">
					<p class="text-center text-sm font-semibold text-red-900">
						⚠️ <strong>IMPORTANT:</strong> Do not modify the payment amount during checkout. If you change
						the amount, your transaction will be marked as tampered and you will need to contact support
						for assistance.
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
			{#if pricingLoaded && volumeLimited}
				<div class="flex gap-3">
					<button
						onclick={onClose}
						class="shadow-brutalist hover:shadow-brutalist-lg w-full rounded-xl border-4 border-black bg-gray-200 py-3 font-bold text-black transition-all hover:translate-x-[-2px] hover:translate-y-[-2px]"
					>
						Close
					</button>
				</div>
			{:else}
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
						disabled={isSubmitting || isLoadingPricing || !pricingLoaded}
						class="shadow-brutalist hover:shadow-brutalist-lg flex-1 rounded-xl border-4 border-black bg-gradient-to-r from-purple-500 to-pink-500 py-3 font-black text-white transition-all hover:translate-x-[-2px] hover:translate-y-[-2px] disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if isLoadingPricing || !pricingLoaded}
							⏳ Calculating...
						{:else if isSubmitting}
							⏳ Processing...
						{:else if isFree}
							🎉 Start Free Analysis
						{:else}
							💳 Proceed to Payment
						{/if}
					</button>
				</div>
			{/if}

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
