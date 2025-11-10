<script lang="ts">
	export let status: 'uploading' | 'processing' | 'completed' | 'failed';
	export let uploadProgress: number = 0; // 0-100
	export let message: string = '';
</script>

<div class="mb-6 overflow-hidden rounded-2xl border-4 border-black shadow-brutalist-lg">
	{#if status === 'uploading'}
		<div class="bg-gradient-to-r from-blue-100 to-purple-100 p-6">
			<div class="mb-3 flex items-center gap-3">
				<div class="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-black"></div>
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
					<div class="relative flex h-full w-full items-center justify-center rounded-full bg-purple-500 text-2xl">
						🤖
					</div>
				</div>
				<div class="flex-1">
					<h3 class="text-xl font-black text-black">AI is Analyzing Your Photos</h3>
					<p class="text-sm font-semibold text-gray-700">This may take a few hours</p>
				</div>
			</div>

			<div class="rounded-lg border-2 border-purple-300 bg-white p-4">
				<p class="mb-2 text-sm font-bold text-purple-900">What's happening:</p>
				<ul class="space-y-1 text-sm text-gray-700">
					<li class="flex items-center gap-2">
						<span class="text-purple-500">✓</span> Grouping similar photos
					</li>
					<li class="flex items-center gap-2">
						<span class="text-purple-500">✓</span> Analyzing quality and composition
					</li>
					<li class="flex items-center gap-2">
						<span class="text-purple-500">⏳</span> Identifying best versions to keep
					</li>
				</ul>
			</div>

			<p class="mt-4 text-center text-sm font-semibold text-gray-600">
				Check back in a few hours. We'll have your results ready!
			</p>

			<p class="mt-2 text-center text-xs text-gray-500">
				Need help? Contact <a href="mailto:support@tallisa.dev" class="font-semibold text-purple-600 hover:underline">support@tallisa.dev</a>
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
			<p class="mt-3 text-center text-xs text-gray-500">
				Contact <a href="mailto:support@tallisa.dev" class="font-semibold text-red-600 hover:underline">support@tallisa.dev</a> for assistance
			</p>
		</div>
	{/if}
</div>

<style>
	@keyframes ping {
		75%, 100% {
			transform: scale(2);
			opacity: 0;
		}
	}

	.animate-ping {
		animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
</style>
