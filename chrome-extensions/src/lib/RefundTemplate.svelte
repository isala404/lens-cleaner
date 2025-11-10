<script lang="ts">
  import { apiClient } from './api-client';

  export let jobId: string;
  export let userEmail: string;
  export let onClose: () => void;

  let loading = false;
  let template = { subject: '', body: '', to: '', unused_photos: 0, refund_amount: 0 };
  let error: string | null = null;

  async function loadTemplate() {
    loading = true;
    error = null;

    try {
      template = await apiClient.getRefundTemplate(jobId, userEmail);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load refund template';
    } finally {
      loading = false;
    }
  }

  function copyToClipboard() {
    const text = `To: ${template.to}\nSubject: ${template.subject}\n\n${template.body}`;
    navigator.clipboard.writeText(text);
  }

  function openEmailClient() {
    const mailtoLink = `mailto:${template.to}?subject=${encodeURIComponent(template.subject)}&body=${encodeURIComponent(template.body)}`;
    window.open(mailtoLink, '_blank');
  }

  // Load on mount
  loadTemplate();
</script>

<div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-2xl max-w-2xl w-full mx-4 p-8 border-4 border-black max-h-[90vh] overflow-y-auto">

    {#if loading}
      <div class="text-center py-12">
        <div class="animate-spin text-6xl mb-4">⏳</div>
        <p>Loading refund template...</p>
      </div>
    {:else if error}
      <div class="text-center">
        <div class="text-6xl mb-4">❌</div>
        <h2 class="text-2xl font-bold mb-4">Error</h2>
        <p class="text-red-600 mb-6">{error}</p>
        <button
          on:click={onClose}
          class="bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold"
        >
          Close
        </button>
      </div>
    {:else}
      <h2 class="text-3xl font-bold mb-4">Request Refund</h2>

      <div class="bg-yellow-100 border-4 border-black p-6 rounded-lg mb-6">
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div class="font-bold">Unused Photos:</div>
            <div class="text-2xl">{template.unused_photos}</div>
          </div>
          <div>
            <div class="font-bold">Refund Amount:</div>
            <div class="text-2xl text-green-600">${template.refund_amount.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <div class="mb-4">
        <label class="block font-bold mb-2 text-sm">To:</label>
        <input
          type="text"
          value={template.to}
          readonly
          class="w-full border-4 border-black rounded-lg px-4 py-2 bg-gray-50"
        />
      </div>

      <div class="mb-4">
        <label class="block font-bold mb-2 text-sm">Subject:</label>
        <input
          type="text"
          value={template.subject}
          readonly
          class="w-full border-4 border-black rounded-lg px-4 py-2 bg-gray-50"
        />
      </div>

      <div class="mb-6">
        <label class="block font-bold mb-2 text-sm">Email Body:</label>
        <textarea
          value={template.body}
          readonly
          rows="12"
          class="w-full border-4 border-black rounded-lg px-4 py-2 bg-gray-50 font-mono text-sm"
        ></textarea>
      </div>

      <div class="flex gap-4">
        <button
          on:click={openEmailClient}
          class="flex-1 bg-purple-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-purple-600 font-bold transition-all hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
        >
          📧 Open Email Client
        </button>
        <button
          on:click={copyToClipboard}
          class="flex-1 bg-blue-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-blue-600 font-bold transition-all"
        >
          📋 Copy to Clipboard
        </button>
        <button
          on:click={onClose}
          class="bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold"
        >
          Close
        </button>
      </div>

      <div class="mt-6 bg-blue-100 border-2 border-black p-4 rounded-lg text-sm">
        <p class="font-bold mb-2">How to request a refund:</p>
        <ol class="list-decimal list-inside space-y-1 text-gray-700">
          <li>Click "Open Email Client" to compose the email</li>
          <li>Or copy the template and paste it into your email client</li>
          <li>Send to {template.to}</li>
          <li>We'll process your refund within 5-7 business days</li>
        </ol>
      </div>
    {/if}

  </div>
</div>
