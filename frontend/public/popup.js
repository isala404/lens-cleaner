/**
 * Popup JavaScript - Ultra-simplified approach
 * One-button workflow for grandma-friendly UX
 */

let currentTab = null;
let isProcessing = false;
let hasScannedPhotos = false;

// Initialize on popup open
document.addEventListener('DOMContentLoaded', async () => {
  await loadStats();
  await checkCurrentTab();
  setupEventListeners();
  startStatusPolling();
});

/**
 * Load stats from service worker
 */
async function loadStats() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getStats' });

    if (response && response.success) {
      const stats = response.stats;
      hasScannedPhotos = stats.totalPhotos > 0;

      document.getElementById('totalPhotos').textContent = stats.totalPhotos;
      document.getElementById('totalGroups').textContent = stats.totalGroups;

      updateButtonStates();
    }
  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

/**
 * Update button states based on scan status
 */
function updateButtonStates() {
  const startBtn = document.getElementById('startScan');
  const clearBtn = document.getElementById('clearData');
  const dashboardBtn = document.getElementById('openDashboard');

  if (!startBtn) return;

  if (isProcessing) {
    startBtn.disabled = true;
    startBtn.textContent = '⏳ Scanning...';
    if (clearBtn) {
      clearBtn.classList.add('hidden');
    }
    if (dashboardBtn) {
      dashboardBtn.style.display = 'none';
    }
  } else if (hasScannedPhotos) {
    // Has scanned photos - show "View Results" as primary, "Scan Again" and "Clear" as secondary
    startBtn.classList.remove('btn-primary', 'btn-danger-outline');
    startBtn.classList.add('btn-secondary');
    startBtn.disabled = false;
    startBtn.textContent = '🔄 Scan More Photos';
    if (clearBtn) {
      clearBtn.classList.remove('hidden');
    }
    if (dashboardBtn) {
      dashboardBtn.style.display = 'block';
      dashboardBtn.classList.remove('btn-secondary');
      dashboardBtn.classList.add('btn-primary');
      dashboardBtn.textContent = '📊 View Results';
    }
  } else {
    // No scanned photos - show "Find Duplicates" as primary
    startBtn.classList.remove('btn-danger-outline', 'btn-secondary');
    startBtn.classList.add('btn-primary');
    startBtn.disabled = false;
    startBtn.textContent = '🔍 Find Duplicates';
    if (clearBtn) {
      clearBtn.classList.add('hidden');
    }
    if (dashboardBtn) {
      dashboardBtn.style.display = 'block';
      dashboardBtn.classList.remove('btn-primary');
      dashboardBtn.classList.add('btn-secondary');
      dashboardBtn.textContent = '📊 View Results';
    }
  }
}

/**
 * Check if current tab is Google Photos
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    const isGooglePhotos = tab.url && tab.url.includes('photos.google.com');

    if (isGooglePhotos) {
      document.getElementById('notOnGooglePhotos').classList.add('hidden');
      document.getElementById('onGooglePhotos').classList.remove('hidden');
    } else {
      document.getElementById('notOnGooglePhotos').classList.remove('hidden');
      document.getElementById('onGooglePhotos').classList.add('hidden');
    }
  } catch (error) {
    console.error('Error checking current tab:', error);
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Open Google Photos
  document.getElementById('openGooglePhotos').addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://photos.google.com',
      active: true
    });
  });

  // Open dashboard
  document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('dashboard.html')
    });
  });

  // Start scan
  document.getElementById('startScan').addEventListener('click', async () => {
    await startScan();
  });

  // Clear all data
  document.getElementById('clearData').addEventListener('click', async () => {
    await handleClearData();
  });
}

/**
 * Ensure content script is loaded
 * Fixes bug where extension doesn't work on already-opened tabs
 */
async function ensureContentScriptLoaded(tabId) {
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    console.log('Content script already loaded');
    return true;
  } catch (error) {
    console.log('Content script not loaded, injecting...');

    try {
      // Inject the content script
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content-scraper.js']
      });

      // Wait a bit for the script to initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('Content script injected successfully');
      return true;
    } catch (injectError) {
      console.error('Failed to inject content script:', injectError);
      return false;
    }
  }
}

/**
 * Handle clearing all data
 */
async function handleClearData() {
  const confirmed = confirm(
    'This will remove everything stored by Lens Cleaner.\n\n' +
    'Think of it like clearing out your desk to start fresh.\n\n' +
    'You\'ll need to scan your photos again from Google Photos.\n\n' +
    'Is this what you want to do?'
  );

  if (!confirmed) {
    return;
  }

  try {
    showMessage('Clearing everything...', 'info');
    await chrome.runtime.sendMessage({ action: 'clearAllData' });
    hasScannedPhotos = false;
    await loadStats();
    updateButtonStates();
    showMessage('All cleared! Ready for a fresh start.', 'success');
  } catch (error) {
    console.error('Error clearing data:', error);
    showMessage('Oops! Something went wrong while clearing.', 'error');
  }
}

/**
 * Start scanning
 */
async function startScan() {
  if (!currentTab) {
    showMessage('No active tab found', 'error');
    return;
  }

  if (isProcessing) {
    showMessage('Already scanning your photos...', 'info');
    return;
  }

  try {
    isProcessing = true;
    showMessage('Getting ready to scan...', 'info');
    updateButtonStates();

    // Ensure content script is loaded (fixes bug with already-opened tabs)
    const scriptLoaded = await ensureContentScriptLoaded(currentTab.id);

    if (!scriptLoaded) {
      showMessage('Please refresh this Google Photos page and try again', 'error');
      isProcessing = false;
      updateButtonStates();
      return;
    }

    console.log('Starting scan on tab:', currentTab.id);

    // Send message to content script
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      action: 'startScraping',
      options: {
        maxItems: 1000,
        itemDelay: 100,
        scrollDelay: 2000,
        maxStaleScrolls: 5
      }
    });

    if (response && response.status === 'started') {
      showMessage('Looking through your photos...', 'success');
      updateButtonStates();
      console.log('Scan started successfully');
    }
  } catch (error) {
    console.error('Error starting scan:', error);
    showMessage('Could not start. Make sure you\'re on Google Photos.', 'error');
    isProcessing = false;
    updateButtonStates();
  }
}

/**
 * Show message to user
 */
function showMessage(text, type = 'info') {
  const messageEl = document.getElementById('message');
  if (messageEl) {
    messageEl.textContent = text;
    messageEl.className = 'message';
    messageEl.classList.add(type);
    messageEl.classList.remove('hidden');

    if (type !== 'info') {
      setTimeout(() => {
        messageEl.classList.add('hidden');
      }, 3000);
    }
  }
}

/**
 * Poll for scanning status
 */
function startStatusPolling() {
  setInterval(async () => {
    if (!currentTab) return;

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'getScrapingStatus'
      });

      if (response) {
        if (response.isActive && !isProcessing) {
          // Scan is running but we didn't know
          isProcessing = true;
          updateButtonStates();
        } else if (!response.isActive && isProcessing) {
          // Scan finished
          isProcessing = false;
          showMessage('All done! Click "View Results" to see what we found.', 'success');
          // Refresh stats
          await loadStats();
        }
      }
    } catch (error) {
      // Content script not loaded or tab closed - this is normal
    }
  }, 1000); // Poll every second
}
