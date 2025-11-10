<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiClient } from './api-client';
  import { UploadManager } from './upload-manager';
  import aiDB, { type AIJob } from './ai-db';
  import db from './db';

  export let groups: Map<string, string[]>; // groupId -> photoIds[]
  export let onComplete: (results: Map<string, { shouldDelete: boolean; reason?: string; confidence: string }>) => void;
  export let onCancel: () => void;

  let step: 'calculate' | 'payment' | 'uploading' | 'processing' | 'completed' | 'error' = 'calculate';
  let cost = { total: 0, photoCount: 0, pricePerPhoto: 0.01 };
  let error: string | null = null;

  // Job state
  let jobId: string | null = null;
  let paymentId: string | null = null;
  let userId = ''; // User should enter email

  // Upload state
  let uploadProgress = { total: 0, uploaded: 0, failed: 0, inProgress: 0, percentage: 0 };
  let uploadManager: UploadManager | null = null;

  // Processing state
  let jobStatus = { status: '', progress: 0, estimatedTime: 0 };
  let pollInterval: number | null = null;

  // Calculate total photos in groups
  let totalPhotos = 0;
  $: totalPhotos = Array.from(groups.values()).reduce((sum, photoIds) => sum + photoIds.length, 0);

  onMount(async () => {
    await aiDB.init();

    // Check if there's an active job
    const latestJob = await aiDB.getLatestJob();
    if (latestJob && (latestJob.status === 'uploading' || latestJob.status === 'processing')) {
      // Resume existing job
      jobId = latestJob.id;
      if (latestJob.status === 'uploading') {
        step = 'uploading';
        await resumeUploading();
      } else if (latestJob.status === 'processing') {
        step = 'processing';
        startPolling();
      }
    }
  });

  onDestroy(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  async function calculateCost() {
    try {
      const response = await apiClient.calculateCost(totalPhotos);
      cost = {
        total: response.total_cost,
        photoCount: response.photo_count,
        pricePerPhoto: response.price_per_photo
      };
      step = 'payment';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to calculate cost';
      step = 'error';
    }
  }

  async function handlePayment() {
    if (!userId) {
      error = 'Please enter your email address';
      return;
    }

    // This should integrate with Polar.sh
    // For now, we'll simulate a payment
    // In production, redirect to Polar payment page

    // TODO: Integrate with Polar.sh payment
    // window.open(`https://polar.sh/checkout?...`, '_blank');

    // Simulate payment success (in production, this would be a webhook callback)
    paymentId = `polar_${Date.now()}`;

    try {
      // Create payment record
      const payment = await apiClient.createPayment(
        userId,
        totalPhotos,
        cost.total,
        paymentId,
        'polar'
      );

      // Create job
      const job = await apiClient.createJob(payment.payment_id, userId, totalPhotos);
      jobId = job.job_id;

      // Save job to IndexedDB
      await aiDB.saveJob({
        id: job.job_id,
        paymentId: payment.payment_id,
        userId,
        status: 'created',
        totalPhotos,
        uploadedPhotos: 0,
        processedPhotos: 0,
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      step = 'uploading';
      await startUploading();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create job';
      step = 'error';
    }
  }

  async function startUploading() {
    if (!jobId) return;

    try {
      // Get all photo blobs
      const photoMap = new Map<string, Blob>();

      for (const photoIds of groups.values()) {
        for (const photoId of photoIds) {
          const photo = await db.getPhoto(photoId);
          if (photo && photo.blob) {
            photoMap.set(photoId, photo.blob);
          }
        }
      }

      // Create upload manager
      uploadManager = new UploadManager(jobId, photoMap, {
        concurrency: 20,
        maxRetries: 3,
        onProgress: (progress) => {
          uploadProgress = progress;

          // Update job in IndexedDB
          aiDB.updateJobStatus(jobId!, 'uploading', {
            uploadedPhotos: progress.uploaded,
            progress: progress.percentage * 0.5 // First 50% is uploading
          });
        }
      });

      // Start uploading
      const results = await uploadManager.uploadAll();

      // Check if all succeeded
      const failedCount = results.filter(r => !r.success).length;
      if (failedCount > 0) {
        error = `${failedCount} photos failed to upload. Please retry.`;
        return;
      }

      // Submit grouping data
      const groupsData: Record<string, string[]> = {};
      groups.forEach((photoIds, groupId) => {
        groupsData[groupId] = photoIds;
      });

      await apiClient.submitGrouping(jobId, groupsData);

      // Update job status
      await aiDB.updateJobStatus(jobId, 'uploaded');

      // Start polling for results
      step = 'processing';
      startPolling();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Upload failed';
      step = 'error';
    }
  }

  async function resumeUploading() {
    if (!jobId) return;
    // Resume with existing upload manager
    await startUploading();
  }

  function startPolling() {
    if (!jobId) return;

    pollInterval = setInterval(async () => {
      try {
        const status = await apiClient.getJobStatus(jobId!);
        jobStatus = {
          status: status.status,
          progress: status.progress,
          estimatedTime: status.estimated_time || 0
        };

        // Update job in IndexedDB
        await aiDB.updateJobStatus(jobId!, status.status as any, {
          processedPhotos: status.processed_photos,
          progress: status.progress
        });

        if (status.status === 'completed') {
          clearInterval(pollInterval!);
          await handleCompletion();
        } else if (status.status === 'failed') {
          clearInterval(pollInterval!);
          error = status.error_message || 'Processing failed';
          step = 'error';
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 30000); // Poll every 30 seconds
  }

  async function handleCompletion() {
    if (!jobId) return;

    try {
      // Get results from backend
      const response = await apiClient.getResults(jobId);

      // Save results to IndexedDB
      const aiResults = response.results.map(r => ({
        id: r.id,
        jobId: jobId!,
        photoId: r.photo_id,
        groupId: r.group_id,
        shouldDelete: r.should_delete,
        reason: r.reason,
        confidence: r.confidence as 'high' | 'medium' | 'low',
        createdAt: Date.now()
      }));

      await aiDB.saveResults(aiResults);

      // Convert to map for callback
      const resultsMap = new Map<string, { shouldDelete: boolean; reason?: string; confidence: string }>();
      response.results.forEach(r => {
        resultsMap.set(r.photo_id, {
          shouldDelete: r.should_delete,
          reason: r.reason,
          confidence: r.confidence
        });
      });

      step = 'completed';
      onComplete(resultsMap);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to get results';
      step = 'error';
    }
  }

  function retryUpload() {
    if (uploadManager) {
      uploadManager.retryFailed();
    }
  }

  function formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  }
</script>

<div class="auto-select-modal fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-2xl max-w-2xl w-full mx-4 p-8 border-4 border-black">

    {#if step === 'calculate'}
      <h2 class="text-3xl font-bold mb-4">AI Auto-Select</h2>
      <p class="text-gray-700 mb-6">
        Let our AI analyze your {totalPhotos} photos and intelligently select the best ones to keep.
      </p>

      <div class="bg-pink-100 border-4 border-black p-6 rounded-lg mb-6">
        <div class="text-2xl font-bold mb-2">${(totalPhotos * 0.01).toFixed(2)} USD</div>
        <div class="text-sm text-gray-600">
          {totalPhotos} photos × $0.01 per photo
        </div>
      </div>

      <div class="flex gap-4">
        <button
          on:click={calculateCost}
          class="flex-1 bg-purple-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-purple-600 font-bold transition-all hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
        >
          Continue to Payment
        </button>
        <button
          on:click={onCancel}
          class="flex-1 bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold transition-all"
        >
          Cancel
        </button>
      </div>
    {/if}

    {#if step === 'payment'}
      <h2 class="text-3xl font-bold mb-4">Complete Payment</h2>

      <div class="mb-6">
        <label class="block text-sm font-bold mb-2">Email Address</label>
        <input
          type="email"
          bind:value={userId}
          placeholder="your@email.com"
          class="w-full border-4 border-black rounded-lg px-4 py-2"
        />
      </div>

      <div class="bg-yellow-100 border-4 border-black p-6 rounded-lg mb-6">
        <div class="text-xl font-bold mb-2">Total: ${cost.total.toFixed(2)} USD</div>
        <div class="text-sm">
          {cost.photoCount} photos at ${cost.pricePerPhoto}/photo
        </div>
      </div>

      <div class="bg-blue-100 border-2 border-black p-4 rounded-lg mb-6 text-sm">
        <strong>Note:</strong> In production, you'll be redirected to Polar.sh for secure payment.
        For now, this is a demo flow.
      </div>

      <div class="flex gap-4">
        <button
          on:click={handlePayment}
          disabled={!userId}
          class="flex-1 bg-green-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-green-600 font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Pay with Polar.sh
        </button>
        <button
          on:click={() => step = 'calculate'}
          class="flex-1 bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold"
        >
          Back
        </button>
      </div>
    {/if}

    {#if step === 'uploading'}
      <h2 class="text-3xl font-bold mb-4">Uploading Photos...</h2>

      <div class="mb-6">
        <div class="bg-gray-200 h-8 rounded-full border-4 border-black overflow-hidden">
          <div
            class="bg-gradient-to-r from-pink-500 to-purple-500 h-full transition-all duration-300 flex items-center justify-center text-white font-bold"
            style="width: {uploadProgress.percentage}%"
          >
            {uploadProgress.percentage.toFixed(0)}%
          </div>
        </div>
        <div class="mt-2 text-sm text-gray-600 text-center">
          {uploadProgress.uploaded} / {uploadProgress.total} photos uploaded
          {#if uploadProgress.failed > 0}
            <span class="text-red-600">({uploadProgress.failed} failed)</span>
          {/if}
        </div>
      </div>

      {#if uploadProgress.failed > 0}
        <button
          on:click={retryUpload}
          class="w-full bg-yellow-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-yellow-600 font-bold mb-4"
        >
          Retry Failed Uploads
        </button>
      {/if}

      <p class="text-sm text-gray-600 text-center">
        You can close this window. Upload will continue in the background and you can resume later.
      </p>
    {/if}

    {#if step === 'processing'}
      <h2 class="text-3xl font-bold mb-4">AI Processing...</h2>

      <div class="mb-6">
        <div class="bg-gray-200 h-8 rounded-full border-4 border-black overflow-hidden">
          <div
            class="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-300 flex items-center justify-center text-white font-bold"
            style="width: {jobStatus.progress}%"
          >
            {jobStatus.progress.toFixed(0)}%
          </div>
        </div>
        <div class="mt-2 text-sm text-gray-600 text-center">
          {#if jobStatus.estimatedTime > 0}
            Estimated time remaining: {formatTime(jobStatus.estimatedTime)}
          {:else}
            Processing your photos...
          {/if}
        </div>
      </div>

      <div class="bg-purple-100 border-2 border-black p-4 rounded-lg text-sm">
        <p class="mb-2"><strong>What's happening:</strong></p>
        <ul class="list-disc list-inside space-y-1 text-gray-700">
          <li>Our AI is analyzing each photo group</li>
          <li>Identifying duplicates, blurry images, and poor quality shots</li>
          <li>Selecting the best photos to keep</li>
        </ul>
      </div>

      <p class="text-sm text-gray-600 text-center mt-4">
        This can take a few hours. You can close this window and check back later.
      </p>
    {/if}

    {#if step === 'completed'}
      <div class="text-center">
        <div class="text-6xl mb-4">✅</div>
        <h2 class="text-3xl font-bold mb-4">Analysis Complete!</h2>
        <p class="text-gray-700 mb-6">
          Your photos have been analyzed. Check the groups to see which photos are recommended for deletion.
        </p>
        <button
          on:click={() => onComplete(new Map())}
          class="bg-purple-500 text-white px-8 py-3 rounded-lg border-4 border-black hover:bg-purple-600 font-bold transition-all hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
        >
          View Results
        </button>
      </div>
    {/if}

    {#if step === 'error'}
      <div class="text-center">
        <div class="text-6xl mb-4">❌</div>
        <h2 class="text-3xl font-bold mb-4">Error</h2>
        <p class="text-red-600 mb-6">{error}</p>
        <div class="flex gap-4">
          <button
            on:click={() => step = 'calculate'}
            class="flex-1 bg-purple-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-purple-600 font-bold"
          >
            Try Again
          </button>
          <button
            on:click={onCancel}
            class="flex-1 bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold"
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

  </div>
</div>

<style>
  /* Additional styles if needed */
</style>
