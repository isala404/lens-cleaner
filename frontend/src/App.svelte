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
    deleteGroup,
    togglePhotoSelection,
    selectAllInGroup,
    clearSelection,
    updateSettings,
    setViewMode,
    setSortBy,
    setMinGroupSize
  } from './stores/appStore';
  import db, { type Group, type Photo } from './lib/db';

  let showSettings = false;
  let settingsSimilarityThreshold = 0.85;
  let settingsTimeWindow = 60;
  let settingsMaxPhotos = 1000;

  onMount(async () => {
    await initializeApp();
    settingsSimilarityThreshold = $appStore.settings.similarityThreshold;
    settingsTimeWindow = $appStore.settings.timeWindowMinutes;
    settingsMaxPhotos = $appStore.settings.maxPhotos;
  });

  async function handleCalculateEmbeddings() {
    try {
      const count = await calculateEmbeddings();
      alert(`Processed ${count} photos!`);
    } catch (error) {
      alert('Error calculating embeddings: ' + error);
    }
  }

  async function handleGroupPhotos() {
    try {
      const count = await groupPhotos();
      alert(`Created ${count} groups!`);
    } catch (error) {
      alert('Error grouping photos: ' + error);
    }
  }

  async function handleClearData() {
    if (confirm('Are you sure you want to delete all data? This cannot be undone.')) {
      try {
        await clearAllData();
        alert('All data cleared');
      } catch (error) {
        alert('Error clearing data: ' + error);
      }
    }
  }

  async function handleDeleteSelected() {
    if ($appStore.selectedPhotos.size === 0) {
      alert('No photos selected');
      return;
    }

    if (confirm(`Delete ${$appStore.selectedPhotos.size} selected photo(s)?`)) {
      try {
        await deleteSelectedPhotos();
        alert('Photos deleted');
      } catch (error) {
        alert('Error deleting photos: ' + error);
      }
    }
  }

  async function handleDeleteGroup(groupId: string) {
    if (confirm('Delete this group? Photos will not be deleted.')) {
      try {
        await deleteGroup(groupId);
      } catch (error) {
        alert('Error deleting group: ' + error);
      }
    }
  }

  function handleSaveSettings() {
    updateSettings({
      similarityThreshold: settingsSimilarityThreshold,
      timeWindowMinutes: settingsTimeWindow,
      maxPhotos: settingsMaxPhotos
    });
    showSettings = false;
    alert('Settings saved!');
  }

  async function getGroupPhotos(group: Group): Promise<Photo[]> {
    const photos = await Promise.all(group.photoIds.map(id => db.getPhoto(id)));
    return photos.filter(p => p !== undefined) as Photo[];
  }

  $: emptyStateMessage =
    $appStore.stats.totalPhotos === 0 ? 'No Photos Yet' :
    $appStore.stats.photosWithEmbeddings === 0 ? `${$appStore.stats.totalPhotos} Photos Scraped!` :
    $appStore.stats.totalGroups === 0 ? 'Embeddings Calculated!' :
    'No Groups Found';

  $: emptyStateDescription =
    $appStore.stats.totalPhotos === 0 ? 'Open the extension popup on Google Photos to start scanning' :
    $appStore.stats.photosWithEmbeddings === 0 ? 'Click "Calculate AI" below to analyze them' :
    $appStore.stats.totalGroups === 0 ? 'Click "Group Photos" to find similar images' :
    'Adjust filters to see more groups';
</script>

<div class="app-container">
  <!-- Header -->
  <header class="header">
    <div class="header-content">
      <h1 class="logo">📸 Lens Cleaner</h1>
      <div class="header-actions">
        <button onclick={() => refreshData()} class="btn btn-secondary">
          <span>🔄</span> Refresh
        </button>
        <button onclick={() => showSettings = true} class="btn btn-secondary">
          <span>⚙️</span> Settings
        </button>
      </div>
    </div>
  </header>

  <!-- Stats Bar -->
  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-value">{$appStore.stats.totalPhotos}</div>
      <div class="stat-label">Total Photos</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{$appStore.stats.totalGroups}</div>
      <div class="stat-label">Groups Found</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{$appStore.stats.photosWithEmbeddings}</div>
      <div class="stat-label">Processed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{$appStore.stats.photosInGroups}</div>
      <div class="stat-label">In Groups</div>
    </div>
  </div>

  <!-- Action Bar -->
  <div class="action-bar">
    <div class="action-section">
      <h2>Actions</h2>
      <div class="action-buttons">
        <button
          onclick={handleCalculateEmbeddings}
          disabled={$appStore.stats.totalPhotos === 0 || $appStore.processingProgress.isProcessing}
          class="btn btn-primary"
        >
          <span>🧠</span> Calculate AI
        </button>
        <button
          onclick={handleGroupPhotos}
          disabled={$appStore.stats.photosWithEmbeddings === 0 || $appStore.processingProgress.isProcessing}
          class="btn btn-primary"
        >
          <span>📊</span> Group Photos
        </button>
        <button
          onclick={handleDeleteSelected}
          disabled={$appStore.selectedPhotos.size === 0}
          class="btn btn-danger"
        >
          <span>🗑️</span> Delete Selected ({$appStore.selectedPhotos.size})
        </button>
        <button onclick={handleClearData} class="btn btn-danger">
          <span>🗑️</span> Clear All Data
        </button>
      </div>
    </div>
    <div class="action-section">
      <h2>View</h2>
      <div class="filter-controls">
        <select bind:value={$appStore.viewMode} onchange={() => setViewMode($appStore.viewMode)} class="select">
          <option value="groups">Grouped Photos</option>
          <option value="all">All Photos</option>
        </select>
      </div>
    </div>
    {#if $appStore.viewMode === 'groups'}
      <div class="action-section">
        <h2>Filters</h2>
        <div class="filter-controls">
          <select bind:value={$appStore.sortBy} onchange={() => setSortBy($appStore.sortBy)} class="select">
            <option value="similarity">Sort by Similarity</option>
            <option value="size">Sort by Group Size</option>
            <option value="date">Sort by Date</option>
          </select>
          <input
            type="range"
            bind:value={$appStore.minGroupSize}
            oninput={() => setMinGroupSize($appStore.minGroupSize)}
            min="2"
            max="10"
            class="slider"
          />
          <label>Min Group Size: {$appStore.minGroupSize}</label>
        </div>
      </div>
    {/if}
  </div>

  <!-- Progress Bar -->
  {#if $appStore.processingProgress.isProcessing}
    <div class="progress-bar">
      <div class="progress-content">
        <div class="progress-text">{$appStore.processingProgress.message}</div>
        <div class="progress-track">
          <div
            class="progress-fill"
            style="width: {$appStore.processingProgress.total > 0 ? ($appStore.processingProgress.current / $appStore.processingProgress.total * 100) : 0}%"
          ></div>
        </div>
        <div class="progress-details">
          {$appStore.processingProgress.current} / {$appStore.processingProgress.total}
        </div>
      </div>
    </div>
  {/if}

  <!-- Main Content -->
  <main class="main-content">
    {#if $appStore.viewMode === 'groups' && $filteredGroups.length === 0}
      <!-- Empty State -->
      <div class="empty-state">
        <div class="empty-icon">📷</div>
        <h2>{emptyStateMessage}</h2>
        <p>{emptyStateDescription}</p>
        <ol class="instructions">
          <li>Open the extension popup while on Google Photos</li>
          <li>Click "Start Scan" to scrape photos from your Google Photos library</li>
          <li>Click "Calculate AI" to analyze the photos using machine learning</li>
          <li>Click "Group Photos" to find similar/duplicate images</li>
          <li>Review and delete duplicates!</li>
        </ol>
      </div>
    {:else if $appStore.viewMode === 'groups'}
      <!-- Groups Grid -->
      <div class="groups-container">
        {#each $filteredGroups as group (group.id)}
          {#await getGroupPhotos(group)}
            <div class="group-card">Loading...</div>
          {:then photos}
            <div class="group-card">
              <div class="group-header">
                <div class="group-info">
                  <span class="group-badge">{photos.length} Photos</span>
                  <span class="group-meta">
                    Similarity: {((group.similarityScore || 0.9) * 100).toFixed(0)}%
                  </span>
                </div>
                <div class="group-actions">
                  <button onclick={() => selectAllInGroup(group.id)} class="btn btn-secondary btn-sm">
                    Select All
                  </button>
                  <button onclick={() => handleDeleteGroup(group.id)} class="btn btn-danger btn-sm">
                    Delete Group
                  </button>
                </div>
              </div>
              <div class="group-photos">
                {#each photos as photo}
                  <div
                    class="photo-item"
                    class:selected={$appStore.selectedPhotos.has(photo.id)}
                    onclick={() => togglePhotoSelection(photo.id)}
                  >
                    <img src="data:image/jpeg;base64,{photo.base64}" alt="Photo" />
                    <div class="photo-checkbox" class:checked={$appStore.selectedPhotos.has(photo.id)}>
                      {#if $appStore.selectedPhotos.has(photo.id)}✓{/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/await}
        {/each}
      </div>
    {:else}
      <!-- All Photos View -->
      <div class="group-photos">
        {#each $appStore.photos.sort((a, b) => new Date(b.dateTaken).getTime() - new Date(a.dateTaken).getTime()) as photo}
          <div
            class="photo-item"
            class:selected={$appStore.selectedPhotos.has(photo.id)}
            onclick={() => togglePhotoSelection(photo.id)}
          >
            <img src="data:image/jpeg;base64,{photo.base64}" alt="Photo" />
            <div class="photo-checkbox" class:checked={$appStore.selectedPhotos.has(photo.id)}>
              {#if $appStore.selectedPhotos.has(photo.id)}✓{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

<!-- Settings Modal -->
{#if showSettings}
  <div class="modal" onclick={() => showSettings = false}>
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="modal-close" onclick={() => showSettings = false}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="setting-group">
          <label for="similarityThreshold">Similarity Threshold</label>
          <input
            type="range"
            id="similarityThreshold"
            bind:value={settingsSimilarityThreshold}
            min="0.7"
            max="0.98"
            step="0.01"
          />
          <span>{settingsSimilarityThreshold.toFixed(2)}</span>
          <p class="setting-description">Higher values = stricter matching (only very similar photos)</p>
        </div>
        <div class="setting-group">
          <label for="timeWindow">Time Window (minutes)</label>
          <input
            type="number"
            id="timeWindow"
            bind:value={settingsTimeWindow}
            min="5"
            max="1440"
          />
          <p class="setting-description">Photos taken within this time window can be grouped</p>
        </div>
        <div class="setting-group">
          <label for="maxPhotos">Max Photos to Process</label>
          <input
            type="number"
            id="maxPhotos"
            bind:value={settingsMaxPhotos}
            min="10"
            max="10000"
          />
          <p class="setting-description">Maximum number of photos to process (more = longer processing)</p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick={handleSaveSettings}>Save Settings</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Component Styles */
  .header {
    background: white;
    border-radius: 16px;
    padding: 24px 32px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1);
    margin-bottom: 24px;
  }

  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .logo {
    font-size: 28px;
    font-weight: 700;
    color: #667eea;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-actions {
    display: flex;
    gap: 12px;
  }

  /* Stats Bar */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: white;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    transition: transform 0.2s;
  }

  .stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }

  .stat-value {
    font-size: 32px;
    font-weight: 700;
    color: #667eea;
    margin-bottom: 8px;
  }

  .stat-label {
    font-size: 14px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Action Bar */
  .action-bar {
    background: white;
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    margin-bottom: 24px;
  }

  .action-section {
    margin-bottom: 20px;
  }

  .action-section:last-child {
    margin-bottom: 0;
  }

  .action-section h2 {
    font-size: 18px;
    margin-bottom: 12px;
    color: #333;
  }

  .action-buttons {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .filter-controls {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
  }

  /* Buttons */
  .btn {
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-secondary {
    background: #f3f4f6;
    color: #333;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #e5e7eb;
  }

  .btn-danger {
    background: #ef4444;
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: #dc2626;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
  }

  .btn-sm {
    padding: 8px 16px;
    font-size: 12px;
  }

  /* Select & Input */
  .select {
    padding: 10px 16px;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
    font-size: 14px;
    background: white;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .select:focus {
    outline: none;
    border-color: #667eea;
  }

  .slider {
    width: 150px;
    height: 6px;
    border-radius: 3px;
    background: #e5e7eb;
    outline: none;
    -webkit-appearance: none;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
  }

  .slider::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
    border: none;
  }

  /* Progress Bar */
  .progress-bar {
    background: white;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    margin-bottom: 24px;
  }

  .progress-text {
    font-weight: 600;
    margin-bottom: 12px;
    color: #333;
  }

  .progress-track {
    width: 100%;
    height: 8px;
    background: #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-details {
    font-size: 14px;
    color: #666;
  }

  /* Main Content */
  .main-content {
    background: white;
    border-radius: 16px;
    padding: 32px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    min-height: 400px;
  }

  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
  }

  .empty-icon {
    font-size: 80px;
    margin-bottom: 20px;
  }

  .empty-state h2 {
    font-size: 28px;
    margin-bottom: 12px;
    color: #333;
  }

  .empty-state p {
    font-size: 16px;
    color: #666;
    margin-bottom: 32px;
  }

  .instructions {
    text-align: left;
    max-width: 500px;
    margin: 0 auto;
    background: #f9fafb;
    padding: 24px;
    border-radius: 12px;
    line-height: 1.8;
  }

  .instructions li {
    margin-bottom: 12px;
    color: #555;
  }

  /* Groups Container */
  .groups-container {
    display: flex;
    flex-direction: column;
    gap: 32px;
  }

  /* Group Card */
  .group-card {
    border: 2px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    background: #fafafa;
    transition: all 0.2s;
  }

  .group-card:hover {
    border-color: #667eea;
    box-shadow: 0 4px 16px rgba(102, 126, 234, 0.15);
  }

  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .group-info {
    display: flex;
    gap: 16px;
    align-items: center;
  }

  .group-badge {
    background: #667eea;
    color: white;
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
  }

  .group-meta {
    font-size: 14px;
    color: #666;
  }

  .group-actions {
    display: flex;
    gap: 8px;
  }

  .group-photos {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }

  .photo-item {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    border: 3px solid transparent;
    transition: all 0.2s;
  }

  .photo-item:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .photo-item.selected {
    border-color: #667eea;
  }

  .photo-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .photo-checkbox {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 24px;
    height: 24px;
    background: white;
    border: 2px solid #667eea;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
  }

  .photo-checkbox.checked {
    background: #667eea;
    color: white;
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
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px;
    border-bottom: 1px solid #e5e7eb;
  }

  .modal-header h2 {
    font-size: 24px;
    color: #333;
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
    border-top: 1px solid #e5e7eb;
    display: flex;
    justify-content: flex-end;
  }

  .setting-group {
    margin-bottom: 24px;
  }

  .setting-group:last-child {
    margin-bottom: 0;
  }

  .setting-group label {
    display: block;
    font-weight: 600;
    margin-bottom: 8px;
    color: #333;
  }

  .setting-group input[type="range"] {
    width: 100%;
    margin-bottom: 8px;
  }

  .setting-group input[type="number"] {
    width: 100%;
    padding: 10px;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
    font-size: 14px;
  }

  .setting-description {
    font-size: 13px;
    color: #666;
    margin-top: 4px;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .header-content {
      flex-direction: column;
      gap: 16px;
    }

    .stats-bar {
      grid-template-columns: repeat(2, 1fr);
    }

    .action-buttons {
      flex-direction: column;
    }

    .btn {
      width: 100%;
      justify-content: center;
    }

    .group-photos {
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    }
  }
</style>
