<script lang="ts">
	export let status: 'uploading' | 'processing' | 'completed' | 'failed' | 'tampered';
	export let uploadProgress: number = 0; // 0-100
	export let message: string = '';
	export let canRetry: boolean = false;
	export let onRetry: () => void = () => {};
	export let canRefund: boolean = false;
	export let onRefund: () => void = () => {};
	export let refundLoading: boolean = false;
	export let jobId: string | null = null;

	const supportEmail = 'support@tallisa.dev';

	// Tampered state email
	$: tamperedSubject = jobId ? `Payment Issue Job ${jobId}` : 'Payment Amount Modified';
	$: tamperedBody = jobId
		? `Hello,\n\nI am contacting support regarding a payment amount modification for job ${jobId}.\n\nDetails:\n`
		: 'Hello,\n\nI am contacting support regarding a payment amount modification.\n\nDetails:\n';
	$: tamperedHref = `mailto:${supportEmail}?subject=${encodeURIComponent(tamperedSubject)}&body=${encodeURIComponent(tamperedBody)}`;

	// Failed state email
	$: failedSubject = jobId ? `Help Needed for Job ${jobId}` : 'Processing Failed Help';
	$: failedBody = jobId
		? `Hello,\n\nI need help with job ${jobId} which failed to process.\n\nDetails:\n`
		: 'Hello,\n\nI need help with a failed processing job.\n\nDetails:\n';
	$: failedHref = `mailto:${supportEmail}?subject=${encodeURIComponent(failedSubject)}&body=${encodeURIComponent(failedBody)}`;

	// General/Processing state email
	$: processingSubject = jobId
		? `Question about Job ${jobId}`
		: 'Question about TopPics Processing';
	$: processingBody = jobId
		? `Hello,\n\nI have a question about my processing job ${jobId}.\n\nQuestion:\n`
		: 'Hello,\n\nI have a question about TopPics processing.\n\nQuestion:\n';
	$: processingHref = `mailto:${supportEmail}?subject=${encodeURIComponent(processingSubject)}&body=${encodeURIComponent(processingBody)}`;
</script>

<div class="shadow-brutalist-lg mb-6 overflow-hidden rounded-2xl border-4 border-black">
	{#if status === 'uploading'}
		<div class="bg-gradient-to-r from-blue-100 to-purple-100 p-6">
			<div class="mb-3 flex items-center gap-3">
				<div
					class="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-black"
				></div>
				<h3 class="text-xl font-black text-black">Uploading Photos...</h3>
			</div>
			<div class="mb-2 h-4 w-full overflow-hidden rounded-full border-2 border-black bg-white">
				<div
					class="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
					style="width: {uploadProgress}%"
				></div>
			</div>
			<p class="text-sm font-semibold text-gray-700">{uploadProgress}% complete</p>
		</div>
	{:else if status === 'processing'}
		<div class="bg-gradient-to-r from-purple-100 to-pink-100 p-6">
			<div class="mb-4 flex items-center gap-3">
				<div class="relative h-12 w-12">
					<div class="absolute inset-0 animate-ping rounded-full bg-purple-400 opacity-75"></div>
					<div
						class="relative flex h-full w-full items-center justify-center rounded-full bg-purple-500 text-2xl"
					>
						🤖
					</div>
				</div>
				<div class="flex-1">
					<h3 class="text-xl font-black text-black">AI is Analyzing Your Photos</h3>
					<p class="text-sm font-semibold text-gray-700">This may take a few hours</p>
				</div>
			</div>

			<p class="text-center text-sm font-semibold text-gray-600">
				Check back in a few hours. We'll have your results ready!
			</p>

			<p class="mt-2 text-center text-xs text-gray-500">
				Need help? Contact <a
					href={processingHref}
					target="_blank"
					rel="noopener noreferrer"
					class="font-semibold text-purple-600 hover:underline">support@tallisa.dev</a
				>
			</p>
		</div>
	{:else if status === 'completed'}
		<div class="bg-gradient-to-r from-green-100 to-emerald-100 p-6">
			<div class="flex items-center gap-3">
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-500 text-2xl">
					✓
				</div>
				<div class="flex-1">
					<h3 class="text-xl font-black text-black">Analysis Complete!</h3>
					<p class="text-sm font-semibold text-gray-700">
						AI has selected photos for deletion. Review below.
					</p>
				</div>
			</div>
		</div>
	{:else if status === 'tampered'}
		<div class="bg-gradient-to-r from-yellow-100 to-red-100 p-6">
			<div class="flex items-center gap-3">
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-yellow-500 text-2xl">
					⚠️
				</div>
				<div class="flex-1">
					<h3 class="text-xl font-black text-black">Payment Amount Modified</h3>
					<p class="text-sm font-semibold text-gray-700">
						{message ||
							'The payment amount was modified during checkout. Please contact support for assistance.'}
					</p>
				</div>
			</div>

			<div class="mt-4">
				<a
					href={tamperedHref}
					target="_blank"
					rel="noopener noreferrer"
					class="block w-full rounded-xl border-2 border-black bg-yellow-500 px-4 py-3 text-center font-bold text-white transition-colors hover:bg-yellow-600"
				>
					📧 Contact Support
				</a>
			</div>

			<p class="mt-3 text-center text-xs text-gray-500">
				Email <a
					href={tamperedHref}
					target="_blank"
					rel="noopener noreferrer"
					class="font-semibold text-yellow-600 hover:underline">support@tallisa.dev</a
				> to resolve this issue
			</p>
		</div>
	{:else if status === 'failed'}
		<div class="bg-gradient-to-r from-red-100 to-orange-100 p-6">
			<div class="flex items-center gap-3">
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-red-500 text-2xl">
					✕
				</div>
				<div class="flex-1">
					<h3 class="text-xl font-black text-black">Processing Failed</h3>
					<p class="text-sm font-semibold text-gray-700">
						{message || 'Something went wrong. Please try again or contact support.'}
					</p>
				</div>
			</div>

			{#if canRetry}
				<div class="mt-4 flex gap-3">
					<button
						onclick={onRetry}
						class="flex-1 rounded-xl border-2 border-black bg-blue-500 px-4 py-3 font-bold text-white transition-colors hover:bg-blue-600"
					>
						🔄 Retry Processing
					</button>
					{#if canRefund}
						<button
							onclick={onRefund}
							disabled={refundLoading}
							class="flex-1 rounded-xl border-2 border-black bg-orange-500 px-4 py-3 font-bold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{refundLoading ? '⏳ Processing...' : '💰 Request Refund'}
						</button>
					{/if}
				</div>
			{:else if canRefund}
				<div class="mt-4">
					<button
						onclick={onRefund}
						disabled={refundLoading}
						class="w-full rounded-xl border-2 border-black bg-orange-500 px-4 py-3 font-bold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{refundLoading ? '⏳ Processing Refund...' : '💰 Request Refund'}
					</button>
				</div>
			{/if}

			<p class="mt-3 text-center text-xs text-gray-500">
				Contact <a
					href={failedHref}
					target="_blank"
					rel="noopener noreferrer"
					class="font-semibold text-red-600 hover:underline">support@tallisa.dev</a
				> for assistance
			</p>
		</div>
	{/if}
</div>

<style>
	@keyframes ping {
		75%,
		100% {
			transform: scale(2);
			opacity: 0;
		}
	}

	.animate-ping {
		animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
</style>
