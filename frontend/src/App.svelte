<script lang="ts">
  import { onMount } from 'svelte';
  import {
    appStore,
    filteredGroups,
    initializeApp,
    refreshData,
    calculateEmbeddings,
    groupPhotos,
    clearAllData,
    deleteSelectedPhotos,
    togglePhotoSelection,
    selectAllInGroup,
    clearSelection,
    updateSettings,
  } from './stores/appStore';
  import db, { type Group, type Photo } from './lib/db';

  let currentStep: 'welcome' | 'preview' | 'analyzing' | 'grouping' | 'reviewing' = 'welcome';
  let autoProcessing = false;
  let showSettings = false;
  let processingStartTime = 0;
  let processingStartProgress = 0; // Track progress at start for accurate time estimates
  let estimatedTimeRemaining = 0;

  // Settings
  let settings = {
    similarityThreshold: 0.85,
    timeWindowMinutes: 60,
    minGroupSize: 2
  };

  // Cache for group photos to avoid re-fetching
  let groupPhotosCache = new Map<string, Photo[]>();
  let ungroupedPhotos: Photo[] = [];

  // Sorted photos for preview screen (most recent first)
  $: sortedPhotos = [...$appStore.photos].sort((a, b) => {
    const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
    const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;
    return dateB - dateA; // Most recent first
  });

  onMount(async () => {
    await initializeApp();
    settings.similarityThreshold = $appStore.settings.similarityThreshold;
    settings.timeWindowMinutes = $appStore.settings.timeWindowMinutes;
    
    // Check if we need to resume interrupted processing
    if ($appStore.processingProgress.isProcessing) {
      if ($appStore.processingProgress.type === 'embedding') {
        currentStep = 'analyzing';
        autoProcessing = true;
        processingStartTime = Date.now();
        processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from
        // Auto-resume embedding processing
        try {
          await calculateEmbeddings();
          await refreshData();
          // Auto-start grouping after embeddings complete
          await handleStartGrouping();
          determineCurrentStep();
        } catch (error) {
          console.error('Resume error:', error);
          autoProcessing = false;
          determineCurrentStep();
        }
      } else if ($appStore.processingProgress.type === 'grouping') {
        currentStep = 'grouping';
        autoProcessing = true;
        processingStartTime = Date.now();
        processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from
        // Auto-resume grouping
        try {
          await handleStartGrouping();
          determineCurrentStep();
        } catch (error) {
          console.error('Resume error:', error);
          autoProcessing = false;
          determineCurrentStep();
        }
      }
    } else {
      determineCurrentStep();
    }
  });

  function determineCurrentStep() {
    const stats = $appStore.stats;

    if (stats.totalPhotos === 0) {
      currentStep = 'welcome';
    } else if (stats.photosWithEmbeddings === 0) {
      currentStep = 'preview';
    } else if (stats.totalGroups === 0) {
      currentStep = 'analyzing';
    } else {
      currentStep = 'reviewing';
      loadUngroupedPhotos();
    }
  }

  async function handleStartAnalysis() {
    if (autoProcessing) return;

    autoProcessing = true;
    processingStartTime = Date.now();
    processingStartProgress = 0; // Start from 0 for new analysis
    currentStep = 'analyzing';

    try {
      await calculateEmbeddings();
      await refreshData();

      // Auto-start grouping
      await handleStartGrouping();
    } catch (error) {
      console.error('Analysis error:', error);
      autoProcessing = false;
    }
  }

  async function handleStartGrouping() {
    if (!autoProcessing) {
      autoProcessing = true;
      processingStartTime = Date.now();
      processingStartProgress = 0; // Start from 0 for new grouping
    }

    currentStep = 'grouping';

    try {
      await groupPhotos();
      await refreshData();

      // Clear cache when new groups are created
      groupPhotosCache.clear();

      currentStep = 'reviewing';
      await loadUngroupedPhotos();
    } catch (error) {
      console.error('Grouping error:', error);
    } finally {
      autoProcessing = false;
    }
  }

  async function handleDeleteSelected() {
    if ($appStore.selectedPhotos.size === 0) {
      return;
    }

    if (confirm(`Delete ${$appStore.selectedPhotos.size} photo(s) from your collection?`)) {
      try {
        await deleteSelectedPhotos();

        // Clear cache for affected groups
        groupPhotosCache.clear();

        await refreshData();
        await loadUngroupedPhotos();
      } catch (error) {
        alert('Error deleting photos: ' + error);
      }
    }
  }

  async function handleReindex() {
    if (confirm('This will clear all duplicate groups and let you adjust settings to re-analyze. Your scanned photos will be kept. Continue?')) {
      try {
        // Only clear groups and embeddings, keep photos
        await db.clearGroups();
        await db.clearEmbeddings();

        groupPhotosCache.clear();
        ungroupedPhotos = [];

        await refreshData();
        currentStep = 'preview';
      } catch (error) {
        alert('Error reindexing: ' + error);
      }
    }
  }

  async function handleRescan() {
    if (confirm('⚠️ WARNING: This will delete all scanned photos and groups. You will need to scan from Google Photos again. Continue?')) {
      try {
        await clearAllData();
        groupPhotosCache.clear();
        ungroupedPhotos = [];
        await refreshData();
        currentStep = 'welcome';
      } catch (error) {
        alert('Error clearing data: ' + error);
      }
    }
  }

  function handleSaveSettings() {
    updateSettings({
      similarityThreshold: settings.similarityThreshold,
      timeWindowMinutes: settings.timeWindowMinutes,
    });
    showSettings = false;
  }

  async function getGroupPhotos(group: Group): Promise<Photo[]> {
    // Check cache first
    if (groupPhotosCache.has(group.id)) {
      return groupPhotosCache.get(group.id)!;
    }

    const photos = await Promise.all(group.photoIds.map(id => db.getPhoto(id)));
    const validPhotos = photos.filter(p => p !== undefined) as Photo[];

    // Sort photos by dateTaken (most recent first)
    validPhotos.sort((a, b) => {
      const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
      const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;
      return dateB - dateA; // Most recent first
    });

    // Cache the result
    groupPhotosCache.set(group.id, validPhotos);

    return validPhotos;
  }

  async function loadUngroupedPhotos() {
    try {
      const allPhotos = await db.getAllPhotos();
      const allGroups = await db.getAllGroups();

      // Get all photo IDs that are in groups
      const groupedPhotoIds = new Set<string>();
      allGroups.forEach(group => {
        group.photoIds.forEach(id => groupedPhotoIds.add(id));
      });

      // Filter photos that are NOT in any group
      ungroupedPhotos = allPhotos.filter(photo => !groupedPhotoIds.has(photo.id));
      
      // Sort ungrouped photos by dateTaken (most recent first)
      ungroupedPhotos.sort((a, b) => {
        const dateA = a.dateTaken ? new Date(a.dateTaken).getTime() : a.timestamp;
        const dateB = b.dateTaken ? new Date(b.dateTaken).getTime() : b.timestamp;
        return dateB - dateA; // Most recent first
      });
    } catch (error) {
      console.error('Error loading ungrouped photos:', error);
      ungroupedPhotos = [];
    }
  }

  // Update time estimate
  $: if ($appStore.processingProgress.isProcessing && processingStartTime > 0) {
    const elapsed = Date.now() - processingStartTime;
    const current = $appStore.processingProgress.current;
    const total = $appStore.processingProgress.total;
    const progressMade = current - processingStartProgress; // Only count new progress

    // Only calculate estimate if we've made progress since starting/resuming
    if (progressMade > 0 && total > 0 && elapsed > 0) {
      const rate = progressMade / elapsed; // items per ms (based on new progress only)
      const remaining = total - current;
      estimatedTimeRemaining = remaining / rate; // ms
    } else {
      estimatedTimeRemaining = 0; // Don't show estimate until we have progress
    }
  }

  function formatTimeEstimate(ms: number): string {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
      return `${seconds} seconds`;
    } else if (minutes < 60) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;
    } else {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
    }
  }

  // Filter groups by minimum size
  $: displayGroups = $filteredGroups.filter(g => g.photoIds.length >= settings.minGroupSize);
</script>

<div class="app-container">
  <!-- Header -->
  <header class="header">
    <div class="header-content">
      <h1 class="logo">📸 Lens Cleaner</h1>
      <p class="subtitle">Find and delete duplicate photos</p>
    </div>
    {#if currentStep === 'welcome'}
      <button onclick={() => showSettings = true} class="settings-btn">
        ⚙️ Settings
      </button>
    {/if}
  </header>

  <!-- Progress Steps -->
  <div class="steps">
    <div class="step" class:active={currentStep === 'welcome' || currentStep === 'preview'} class:done={currentStep === 'analyzing' || currentStep === 'grouping' || currentStep === 'reviewing'}>
      <div class="step-number">1</div>
      <div class="step-label">Scan Photos</div>
    </div>
    <div class="step-line" class:done={currentStep === 'analyzing' || currentStep === 'grouping' || currentStep === 'reviewing'}></div>
    <div class="step" class:active={currentStep === 'analyzing' || currentStep === 'grouping'} class:done={currentStep === 'reviewing'}>
      <div class="step-number">2</div>
      <div class="step-label">Find Duplicates</div>
    </div>
    <div class="step-line" class:done={currentStep === 'reviewing'}></div>
    <div class="step" class:active={currentStep === 'reviewing'}>
      <div class="step-number">3</div>
      <div class="step-label">Review & Delete</div>
    </div>
  </div>

  <!-- Main Content -->
  <main class="main-content">
    {#if currentStep === 'welcome'}
      <!-- Welcome Screen -->
      <div class="welcome-screen">
        <div class="welcome-icon">📷</div>
        <h2>Welcome to Lens Cleaner!</h2>
        <p class="welcome-text">
          Let's find and remove duplicate photos from your Google Photos library.
        </p>
        <div class="instructions">
          <div class="instruction-step">
            <div class="instruction-number">1</div>
            <div class="instruction-text">
              <strong>Click the extension icon</strong> while on Google Photos
            </div>
          </div>
          <div class="instruction-step">
            <div class="instruction-number">2</div>
            <div class="instruction-text">
              <strong>Click "Find Duplicates"</strong> to scan your photos
            </div>
          </div>
          <div class="instruction-step">
            <div class="instruction-number">3</div>
            <div class="instruction-text">
              <strong>Come back here</strong> to see and delete duplicates
            </div>
          </div>
        </div>
      </div>

    {:else if currentStep === 'preview'}
      <!-- Preview Screen -->
      <div class="preview-screen">
        <div class="preview-header">
          <div>
            <h2>📷 {$appStore.stats.totalPhotos} Photos Scanned</h2>
            <p class="preview-subtitle">
              Review your scanned photos before analyzing for duplicates
            </p>
          </div>
          <div class="preview-actions">
            <button onclick={handleStartAnalysis} class="btn btn-primary">
              🔍 Start the Scan
            </button>
            <button onclick={() => showSettings = true} class="btn btn-secondary">
              ⚙️ Settings
            </button>
          </div>
        </div>

        <div class="photo-grid">
          {#each sortedPhotos as photo (photo.id)}
            <div class="photo-preview">
              <img src="data:image/jpeg;base64,{photo.base64}" alt="Scanned" loading="lazy" />
            </div>
          {/each}
        </div>
      </div>

    {:else if currentStep === 'analyzing' || currentStep === 'grouping'}
      <!-- Processing Screen -->
      <div class="processing-screen">
        <div class="spinner"></div>
        <h2>
          {#if currentStep === 'analyzing'}
            🧠 Analyzing your photos...
          {:else}
            🔍 Finding duplicates...
          {/if}
        </h2>
        <p class="processing-text">
          {#if $appStore.processingProgress.message}
            {$appStore.processingProgress.message}
          {:else}
            This may take a few moments. We're using AI to compare your photos.
          {/if}
        </p>

        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-number">{$appStore.stats.totalPhotos}</div>
            <div class="stat-label">Photos Scanned</div>
          </div>
          <div class="stat-box">
            <div class="stat-number">
              {#if $appStore.processingProgress.isProcessing}
                {$appStore.processingProgress.current}
              {:else}
                {$appStore.stats.photosWithEmbeddings}
              {/if}
            </div>
            <div class="stat-label">Photos Analyzed</div>
          </div>
        </div>

        {#if $appStore.processingProgress.isProcessing && $appStore.processingProgress.total > 0}
          <div class="progress-container">
            <div class="progress-bar-wrapper">
              <span class="progress-percentage">
                {Math.floor(($appStore.processingProgress.current / $appStore.processingProgress.total * 100))}%
              </span>
              <div class="progress-bar">
                <div class="progress-fill" style="width: {($appStore.processingProgress.current / $appStore.processingProgress.total * 100)}%"></div>
              </div>
            </div>
            <div class="progress-info">
              {#if estimatedTimeRemaining > 0}
                <span class="time-estimate">
                  ~{formatTimeEstimate(estimatedTimeRemaining)} remaining
                </span>
              {/if}
            </div>
          </div>
        {/if}

        <div class="processing-note">
          <span class="note-icon">💡</span>
          <span class="note-text">You can background this tab or close it. Processing continues and progress is saved.</span>
        </div>
      </div>

    {:else if currentStep === 'reviewing'}
      <!-- Review Screen -->
      {#if displayGroups.length === 0 && ungroupedPhotos.length === 0}
        <div class="no-duplicates">
          <div class="no-duplicates-icon">✨</div>
          <h2>No duplicates found!</h2>
          <p>Your photos are already clean.</p>
          <div class="action-buttons">
            <button onclick={handleReindex} class="btn btn-secondary">
              🔄 Reindex with Different Settings
            </button>
            <button onclick={handleRescan} class="btn btn-danger-outline">
              ⚠️ Rescan from Scratch
            </button>
          </div>
        </div>
      {:else}
        <div class="review-screen">
          {#if displayGroups.length > 0}
            <div class="review-header">
              <div>
                <h2>Found {displayGroups.length} duplicate groups</h2>
                <p class="review-subtitle">
                  Click photos to mark for deletion
                </p>
              </div>
              <div class="review-actions">
                {#if $appStore.selectedPhotos.size > 0}
                  <button onclick={clearSelection} class="btn btn-secondary">
                    Clear ({$appStore.selectedPhotos.size})
                  </button>
                  <button onclick={handleDeleteSelected} class="btn btn-danger">
                    🗑️ Delete {$appStore.selectedPhotos.size} Photos
                  </button>
                {:else}
                  <button onclick={handleReindex} class="btn btn-secondary">
                    🔄 Reindex
                  </button>
                {/if}
              </div>
            </div>

            <!-- Duplicate Groups -->
            <div class="groups-container">
              {#each displayGroups as group (group.id)}
                {#await getGroupPhotos(group)}
                  <div class="group-card loading">
                    <div class="loading-spinner"></div>
                  </div>
                {:then photos}
                  <div class="group-card">
                    <div class="group-header">
                      <h3>Duplicate Group ({photos.length} photos)</h3>
                      <button onclick={() => selectAllInGroup(group.id)} class="btn-link">
                        Select All
                      </button>
                    </div>
                    <div class="group-photos">
                      {#each photos as photo (photo.id)}
                        <button
                          class="photo-card"
                          class:selected={$appStore.selectedPhotos.has(photo.id)}
                          onclick={() => togglePhotoSelection(photo.id)}
                          type="button"
                        >
                          <img src="data:image/jpeg;base64,{photo.base64}" alt="Duplicate" loading="lazy" />
                          <div class="photo-overlay">
                            {#if $appStore.selectedPhotos.has(photo.id)}
                              <div class="photo-badge selected">✓ Will Delete</div>
                            {:else}
                              <div class="photo-badge">Click to Select</div>
                            {/if}
                          </div>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/await}
              {/each}
            </div>
          {/if}

          <!-- Ungrouped Photos -->
          {#if ungroupedPhotos.length > 0}
            <div class="ungrouped-section">
              <div class="section-header">
                <h2>📷 {ungroupedPhotos.length} Unique Photos</h2>
                <p class="section-subtitle">These photos have no duplicates</p>
              </div>
              <div class="ungrouped-grid">
                {#each ungroupedPhotos as photo (photo.id)}
                  <div class="ungrouped-photo">
                    <img src="data:image/jpeg;base64,{photo.base64}" alt="Unique" loading="lazy" />
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </main>
</div>

<!-- Settings Modal -->
{#if showSettings}
  <div class="modal" onclick={() => showSettings = false}>
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>⚙️ Settings</h2>
        <button class="modal-close" onclick={() => showSettings = false}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="setting-group">
          <label for="similarityThreshold">
            <strong>Match Sensitivity</strong>
            <span class="setting-hint">How similar photos need to be</span>
          </label>
          <div class="slider-container">
            <span class="slider-label">Loose</span>
            <input
              type="range"
              id="similarityThreshold"
              bind:value={settings.similarityThreshold}
              min="0.70"
              max="0.98"
              step="0.01"
              class="slider"
            />
            <span class="slider-label">Strict</span>
          </div>
          <span class="slider-value">{(settings.similarityThreshold * 100).toFixed(0)}% match required</span>
        </div>

        <div class="setting-group">
          <label for="timeWindow">
            <strong>Time Window</strong>
            <span class="setting-hint">Photos taken within this time can be grouped</span>
          </label>
          <input
            type="number"
            id="timeWindow"
            bind:value={settings.timeWindowMinutes}
            min="5"
            max="1440"
            class="input"
          />
          <span class="input-suffix">minutes</span>
        </div>

        <div class="setting-group">
          <label for="minGroupSize">
            <strong>Minimum Photos per Group</strong>
            <span class="setting-hint">Only show groups with at least this many photos</span>
          </label>
          <input
            type="number"
            id="minGroupSize"
            bind:value={settings.minGroupSize}
            min="2"
            max="10"
            class="input"
          />
          <span class="input-suffix">photos</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick={() => showSettings = false}>Cancel</button>
        <button class="btn btn-primary" onclick={handleSaveSettings}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    background: #f5f7fa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .app-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px 20px;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 40px;
  }

  .header-content {
    text-align: center;
    flex: 1;
  }

  .logo {
    font-size: 36px;
    font-weight: 700;
    color: #667eea;
    margin: 0 0 8px 0;
  }

  .subtitle {
    font-size: 18px;
    color: #64748b;
    margin: 0;
  }

  .settings-btn {
    padding: 10px 20px;
    background: #f1f5f9;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .settings-btn:hover {
    background: #e2e8f0;
  }

  /* Steps */
  .steps {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 48px;
    padding: 0 20px;
  }

  .step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .step-number {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #e2e8f0;
    color: #94a3b8;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 20px;
    transition: all 0.3s;
  }

  .step.active .step-number {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .step.done .step-number {
    background: #10b981;
    color: white;
  }

  .step-label {
    font-size: 14px;
    font-weight: 600;
    color: #64748b;
  }

  .step.active .step-label {
    color: #667eea;
  }

  .step-line {
    width: 80px;
    height: 3px;
    background: #e2e8f0;
    transition: all 0.3s;
  }

  .step-line.done {
    background: #10b981;
  }

  /* Main Content */
  .main-content {
    background: white;
    border-radius: 20px;
    padding: 48px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    min-height: 400px;
  }

  /* Welcome Screen */
  .welcome-screen {
    text-align: center;
    max-width: 600px;
    margin: 0 auto;
    padding: 40px 20px;
  }

  .welcome-icon {
    font-size: 80px;
    margin-bottom: 24px;
  }

  .welcome-screen h2 {
    font-size: 32px;
    color: #1e293b;
    margin-bottom: 16px;
  }

  .welcome-text {
    font-size: 18px;
    color: #64748b;
    margin-bottom: 48px;
    line-height: 1.6;
  }

  .instructions {
    display: flex;
    flex-direction: column;
    gap: 24px;
    text-align: left;
  }

  .instruction-step {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    background: #f8fafc;
    padding: 20px;
    border-radius: 12px;
  }

  .instruction-number {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    flex-shrink: 0;
  }

  .instruction-text {
    font-size: 16px;
    color: #475569;
    line-height: 1.6;
  }

  /* Preview Screen */
  .preview-screen {
    padding: 20px;
  }

  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 2px solid #e2e8f0;
  }

  .preview-header h2 {
    font-size: 28px;
    color: #1e293b;
    margin: 0 0 8px 0;
  }

  .preview-subtitle {
    font-size: 16px;
    color: #64748b;
    margin: 0;
  }

  .preview-actions {
    display: flex;
    gap: 12px;
  }

  .photo-grid, .ungrouped-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
  }

  .photo-preview, .ungrouped-photo {
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    background: #f1f5f9;
  }

  .photo-preview img, .ungrouped-photo img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .more-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .more-text {
    font-size: 18px;
    font-weight: 600;
  }

  /* Processing Screen */
  .processing-screen {
    text-align: center;
    padding: 20px 10px;
  }

  .spinner {
    width: 60px;
    height: 60px;
    border: 5px solid #e2e8f0;
    border-top-color: #667eea;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 32px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .processing-screen h2 {
    font-size: 28px;
    color: #1e293b;
    margin-bottom: 12px;
  }

  .processing-text {
    font-size: 16px;
    color: #64748b;
    margin-bottom: 40px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    max-width: 500px;
    margin: 0 auto 32px;
  }

  .stat-box {
    background: #f8fafc;
    padding: 24px;
    border-radius: 12px;
  }

  .stat-number {
    font-size: 36px;
    font-weight: 700;
    color: #667eea;
    margin-bottom: 8px;
  }

  .stat-label {
    font-size: 14px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .progress-container {
    max-width: 600px;
    margin: 32px auto 0;
  }

  .progress-bar-wrapper {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .progress-percentage {
    font-size: 18px;
    font-weight: 700;
    color: #667eea;
    min-width: 50px;
  }

  .progress-bar {
    flex: 1;
    height: 12px;
    background: #e2e8f0;
    border-radius: 6px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
    transition: width 0.3s;
    box-shadow: 0 0 10px rgba(102, 126, 234, 0.5);
  }

  .progress-info {
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }

  .progress-text {
    font-size: 14px;
    color: #64748b;
    font-weight: 600;
  }

  .time-estimate {
    font-size: 14px;
    color: #667eea;
    font-weight: 600;
  }

  .processing-note {
    margin-top: 48px;
    padding: 16px 24px;
    background: #f0f9ff;
    border: 1px solid #bae6fd;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 700px;
  }

  .note-icon {
    font-size: 20px;
    flex-shrink: 0;
  }

  .note-text {
    font-size: 14px;
    color: #0369a1;
    line-height: 1.5;
  }

  /* No Duplicates */
  .no-duplicates {
    text-align: center;
    padding: 80px 20px;
  }

  .no-duplicates-icon {
    font-size: 80px;
    margin-bottom: 24px;
  }

  .no-duplicates h2 {
    font-size: 32px;
    color: #1e293b;
    margin-bottom: 12px;
  }

  .no-duplicates p {
    font-size: 18px;
    color: #64748b;
    margin-bottom: 32px;
  }

  .action-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
  }

  /* Review Screen */
  .review-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 2px solid #e2e8f0;
  }

  .review-header h2 {
    font-size: 28px;
    color: #1e293b;
    margin: 0 0 8px 0;
  }

  .review-subtitle {
    font-size: 16px;
    color: #64748b;
    margin: 0;
  }

  .review-actions {
    display: flex;
    gap: 12px;
  }

  /* Groups */
  .groups-container {
    display: flex;
    flex-direction: column;
    gap: 32px;
    margin-bottom: 48px;
  }

  .group-card {
    background: #f8fafc;
    border-radius: 16px;
    padding: 24px;
    border: 2px solid #e2e8f0;
    transition: all 0.2s;
  }

  .group-card:hover {
    border-color: #667eea;
    box-shadow: 0 4px 16px rgba(102, 126, 234, 0.1);
  }

  .group-card.loading {
    min-height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading-spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #e2e8f0;
    border-top-color: #667eea;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .group-header h3 {
    font-size: 20px;
    color: #1e293b;
    margin: 0;
  }

  .group-photos {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }

  .photo-card {
    position: relative;
    aspect-ratio: 1;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    border: 3px solid transparent;
    transition: all 0.2s;
    background: none;
    padding: 0;
  }

  .photo-card:hover {
    transform: scale(1.05);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  }

  .photo-card.selected {
    border-color: #ef4444;
  }

  .photo-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .photo-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
    padding: 12px;
    display: flex;
    justify-content: center;
  }

  .photo-badge {
    background: rgba(255, 255, 255, 0.9);
    color: #1e293b;
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
  }

  .photo-badge.selected {
    background: #ef4444;
    color: white;
  }

  /* Ungrouped Section */
  .ungrouped-section {
    margin-top: 48px;
    padding-top: 48px;
    border-top: 3px dashed #e2e8f0;
  }

  .section-header {
    margin-bottom: 24px;
  }

  .section-header h2 {
    font-size: 24px;
    color: #1e293b;
    margin: 0 0 8px 0;
  }

  .section-subtitle {
    font-size: 16px;
    color: #64748b;
    margin: 0;
  }

  /* Buttons */
  .btn {
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  }

  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
  }

  .btn-secondary {
    background: #e2e8f0;
    color: #475569;
  }

  .btn-secondary:hover {
    background: #cbd5e1;
  }

  .btn-danger {
    background: #ef4444;
    color: white;
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
  }

  .btn-danger:hover {
    background: #dc2626;
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(239, 68, 68, 0.4);
  }

  .btn-danger-outline {
    background: white;
    color: #ef4444;
    border: 2px solid #ef4444;
  }

  .btn-danger-outline:hover {
    background: #fef2f2;
  }

  .btn-link {
    background: none;
    border: none;
    color: #667eea;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
  }

  .btn-link:hover {
    text-decoration: underline;
  }

  /* Modal */
  .modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(4px);
  }

  .modal-content {
    background: white;
    border-radius: 16px;
    width: 90%;
    max-width: 600px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px;
    border-bottom: 1px solid #e2e8f0;
  }

  .modal-header h2 {
    font-size: 24px;
    color: #1e293b;
    margin: 0;
  }

  .modal-close {
    background: none;
    border: none;
    font-size: 32px;
    color: #999;
    cursor: pointer;
    line-height: 1;
    padding: 0;
    width: 32px;
    height: 32px;
  }

  .modal-close:hover {
    color: #333;
  }

  .modal-body {
    padding: 24px;
  }

  .modal-footer {
    padding: 24px;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .setting-group {
    margin-bottom: 32px;
  }

  .setting-group:last-child {
    margin-bottom: 0;
  }

  .setting-group label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .setting-hint {
    font-size: 13px;
    color: #64748b;
    font-weight: 400;
  }

  .slider-container {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .slider-label {
    font-size: 13px;
    color: #64748b;
    min-width: 50px;
  }

  .slider {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: #e2e8f0;
    outline: none;
    -webkit-appearance: none;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
  }

  .slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
    border: none;
  }

  .slider-value {
    font-size: 14px;
    color: #667eea;
    font-weight: 600;
  }

  .input {
    width: 100%;
    padding: 10px;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    font-size: 14px;
    margin-bottom: 4px;
  }

  .input:focus {
    outline: none;
    border-color: #667eea;
  }

  .input-suffix {
    font-size: 13px;
    color: #64748b;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .main-content {
      padding: 24px;
    }

    .header {
      flex-direction: column;
      gap: 16px;
    }

    .review-header, .preview-header {
      flex-direction: column;
      gap: 20px;
    }

    .review-actions, .preview-actions {
      width: 100%;
      flex-direction: column;
    }

    .review-actions .btn, .preview-actions .btn {
      width: 100%;
    }

    .group-photos, .photo-grid, .ungrouped-grid {
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    }

    .steps {
      transform: scale(0.85);
    }

    .step-line {
      width: 40px;
    }

    .action-buttons {
      flex-direction: column;
      width: 100%;
    }

    .action-buttons .btn {
      width: 100%;
    }
  }
</style>
