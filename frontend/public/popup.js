/**
 * Popup JavaScript - Simplified approach
 * Stays open, checks current tab, sends message directly
 */

let currentTab = null;
let isScanning = false;

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
      document.getElementById('totalPhotos').textContent = stats.totalPhotos;
      document.getElementById('totalGroups').textContent = stats.totalGroups;
      document.getElementById('processed').textContent = stats.photosWithEmbeddings;
    }
  } catch (error) {
    console.error('Error loading stats:', error);
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

  // Stop scan
  document.getElementById('stopScan').addEventListener('click', async () => {
    await stopScan();
  });
}

/**
 * Start scanning
 */
async function startScan() {
  if (!currentTab) {
    alert('No active tab found');
    return;
  }

  try {
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
      isScanning = true;
      document.getElementById('startScan').classList.add('hidden');
      document.getElementById('stopScan').classList.remove('hidden');
      console.log('Scan started successfully');
    }
  } catch (error) {
    console.error('Error starting scan:', error);
    alert('Failed to start scan. Make sure you\'re on Google Photos and the page is loaded.');
  }
}

/**
 * Stop scanning
 */
async function stopScan() {
  if (!currentTab) return;

  try {
    await chrome.tabs.sendMessage(currentTab.id, {
      action: 'stopScraping'
    });

    isScanning = false;
    document.getElementById('startScan').classList.remove('hidden');
    document.getElementById('stopScan').classList.add('hidden');
  } catch (error) {
    console.error('Error stopping scan:', error);
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
        if (response.isActive && !isScanning) {
          // Scan is running but we didn't know
          isScanning = true;
          document.getElementById('startScan').classList.add('hidden');
          document.getElementById('stopScan').classList.remove('hidden');
        } else if (!response.isActive && isScanning) {
          // Scan finished
          isScanning = false;
          document.getElementById('startScan').classList.remove('hidden');
          document.getElementById('stopScan').classList.add('hidden');
          // Refresh stats
          await loadStats();
        }
      }
    } catch (error) {
      // Content script not loaded or tab closed - this is normal
    }
  }, 1000); // Poll every second
}
