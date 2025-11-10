<script lang="ts">
  export let onConfirm: () => void;
  export let onCancel: () => void;

  let confirmText = '';
  let isValid = false;

  $: isValid = confirmText.trim().toLowerCase() === 'i understand';
</script>

<div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-2xl max-w-lg w-full mx-4 p-8 border-4 border-black">
    <div class="text-center mb-6">
      <div class="text-6xl mb-4">⚠️</div>
      <h2 class="text-3xl font-bold mb-4 text-red-600">Warning!</h2>
    </div>

    <div class="bg-red-100 border-4 border-red-500 p-6 rounded-lg mb-6">
      <p class="font-bold mb-3">Regrouping will discard all AI suggestions!</p>
      <ul class="list-disc list-inside space-y-2 text-sm">
        <li>All auto-selected photos will be unmarked</li>
        <li>You will need to request a refund for unused credits</li>
        <li>AI suggestions cannot be restored</li>
        <li>You will need to pay again for new AI analysis</li>
      </ul>
    </div>

    <div class="mb-6">
      <label class="block font-bold mb-2 text-sm">
        Type "I understand" to continue:
      </label>
      <input
        type="text"
        bind:value={confirmText}
        placeholder="I understand"
        class="w-full border-4 border-black rounded-lg px-4 py-3 font-mono"
        autocomplete="off"
      />
    </div>

    <div class="flex gap-4">
      <button
        on:click={onConfirm}
        disabled={!isValid}
        class="flex-1 bg-red-500 text-white px-6 py-3 rounded-lg border-4 border-black hover:bg-red-600 font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Proceed with Regroup
      </button>
      <button
        on:click={onCancel}
        class="flex-1 bg-gray-200 px-6 py-3 rounded-lg border-4 border-black hover:bg-gray-300 font-bold transition-all"
      >
        Cancel
      </button>
    </div>
  </div>
</div>
