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
	// Check for active scanning with a small delay to ensure content scripts are ready
	setTimeout(async () => {
		await checkForActiveScanning(); // Check if scanning is active on any tab
	}, 100);
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

			// Re-check tab to update UI based on scan status
			await checkCurrentTab();
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
	const messageEl = document.getElementById('message');
	const groupsRow = document.getElementById('groupsRow');

	if (!startBtn) return;

	if (isProcessing) {
		// Ensure button is visible and configured for stopping
		startBtn.classList.remove('hidden');
		startBtn.disabled = false;
		startBtn.textContent = '⏹ Stop Scanning';
		startBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-success');
		startBtn.classList.add('btn-danger');
		if (clearBtn) {
			clearBtn.classList.add('hidden');
		}
		if (dashboardBtn) {
			dashboardBtn.style.display = 'none';
		}
		// Hide duplicate groups row during scanning
		if (groupsRow) {
			groupsRow.classList.add('hidden');
		}
		// Show warning about not closing extension
		if (messageEl) {
			messageEl.textContent = '⚠️ Please keep this extension open or scanning will stop!';
			messageEl.className = 'message info';
			messageEl.classList.remove('hidden');
		}
	} else if (hasScannedPhotos) {
		startBtn.classList.add('hidden');
		if (clearBtn) {
			clearBtn.classList.remove('hidden');
		}
		if (dashboardBtn) {
			dashboardBtn.style.display = 'block';
			dashboardBtn.classList.remove('btn-secondary', 'btn-primary');
			dashboardBtn.classList.add('btn-success');
			dashboardBtn.textContent = '📊 Review Duplicates';
		}
		// Show duplicate groups row when done
		if (groupsRow) {
			groupsRow.classList.remove('hidden');
		}
		// Hide message when not processing
		if (messageEl) {
			messageEl.classList.add('hidden');
		}
	} else {
		// No scanned photos - show "Find Duplicates" as success (green), hide "View Results"
		startBtn.classList.remove(
			'hidden',
			'btn-danger-outline',
			'btn-secondary',
			'btn-danger',
			'btn-primary'
		);
		startBtn.classList.add('btn-success');
		startBtn.disabled = false;
		startBtn.textContent = '🔍 Find Duplicates';
		if (clearBtn) {
			clearBtn.classList.add('hidden');
		}
		if (dashboardBtn) {
			dashboardBtn.style.display = 'none';
		}
		// Show duplicate groups row in default state
		if (groupsRow) {
			groupsRow.classList.remove('hidden');
		}
		// Hide message when not processing
		if (messageEl) {
			messageEl.classList.add('hidden');
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

		// If we have scanned photos, always show the onGooglePhotos section (even if not on Google Photos)
		// This allows users to review duplicates from anywhere
		if (hasScannedPhotos) {
			document.getElementById('notOnGooglePhotos').classList.add('hidden');
			document.getElementById('onGooglePhotos').classList.remove('hidden');
		} else if (isGooglePhotos) {
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

	// Start/Stop scan
	document.getElementById('startScan').addEventListener('click', async () => {
		if (isProcessing) {
			await stopScan();
		} else {
			await startScan();
		}
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
	} catch {
		console.log('Content script not loaded, injecting...');

		try {
			// Inject the content script
			await chrome.scripting.executeScript({
				target: { tabId: tabId },
				files: ['content-scraper.js']
			});

			// Wait a bit for the script to initialize
			await new Promise((resolve) => setTimeout(resolve, 500));
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
			"You'll need to scan your photos again from Google Photos.\n\n" +
			'Is this what you want to do?'
	);

	if (!confirmed) {
		return;
	}

	try {
		await chrome.runtime.sendMessage({ action: 'clearAllData' });
		hasScannedPhotos = false;

		// Update stats display immediately
		document.getElementById('totalPhotos').textContent = '0';
		document.getElementById('totalGroups').textContent = '0';

		// Reload stats to ensure consistency
		await loadStats();

		// Ensure onGooglePhotos section is visible if user is on Google Photos
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		const isGooglePhotos = tab.url && tab.url.includes('photos.google.com');

		if (isGooglePhotos) {
			document.getElementById('notOnGooglePhotos').classList.add('hidden');
			document.getElementById('onGooglePhotos').classList.remove('hidden');
		}

		updateButtonStates();
	} catch (error) {
		console.error('Error clearing data:', error);
		showMessage('Oops! Something went wrong while clearing.', 'error');
	}
}

/**
 * Stop scanning
 */
async function stopScan() {
	// If we don't have currentTab but scanning is active, find the scanning tab
	if (!currentTab && isProcessing) {
		await checkForActiveScanning();
	}

	if (!currentTab) {
		showMessage('Could not find the scanning tab.', 'error');
		return;
	}

	try {
		await chrome.tabs.sendMessage(currentTab.id, {
			action: 'stopScraping'
		});
		isProcessing = false;
		showMessage('Scanning stopped. You can review what was found so far.', 'info');
		await loadStats();
		updateButtonStates();
	} catch (error) {
		console.error('Error stopping scan:', error);
		// Try to find the scanning tab again
		await checkForActiveScanning();
		if (isProcessing) {
			showMessage('Could not stop scanning. Please try again.', 'error');
		}
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
			// Message is now handled in updateButtonStates() when isProcessing is true
			updateButtonStates();
			console.log('Scan started successfully');
		}
	} catch (error) {
		console.error('Error starting scan:', error);
		showMessage("Could not start. Make sure you're on Google Photos.", 'error');
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
 * Check a specific tab for active scanning
 */
async function checkTabForScanning(tab) {
	if (!tab.url || !tab.url.includes('photos.google.com')) {
		return false;
	}

	try {
		console.log('Checking tab', tab.id, 'for active scanning');

		// First try to ping the content script to see if it's loaded
		try {
			await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
		} catch {
			// Content script not loaded, try to inject it
			console.log('Content script not loaded on tab', tab.id, ', attempting to inject...');
			try {
				await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					files: ['content-scraper.js']
				});
				// Wait a bit for script to initialize
				await new Promise((resolve) => setTimeout(resolve, 300));
			} catch {
				console.log('Could not inject content script on tab', tab.id);
				return false;
			}
		}

		// Now check for scraping status
		const response = await chrome.tabs.sendMessage(tab.id, {
			action: 'getScrapingStatus'
		});

		console.log('Response from tab', tab.id, ':', response);

		if (response && response.isActive) {
			// Found active scanning! Update state
			console.log('✅ Found active scanning on tab:', tab.id);
			isProcessing = true;
			currentTab = tab;

			// Ensure onGooglePhotos section is visible
			document.getElementById('notOnGooglePhotos').classList.add('hidden');
			document.getElementById('onGooglePhotos').classList.remove('hidden');

			// Update button states
			updateButtonStates();

			// Update photo count if available
			if (response.progress) {
				const photoCount = response.progress.totalScraped || 0;
				document.getElementById('totalPhotos').textContent = photoCount;
			}

			return true; // Found it!
		}

		return false;
	} catch (error) {
		// Tab might not have content script loaded, skip it
		console.log('Tab', tab.id, 'error:', error.message);
		return false;
	}
}

/**
 * Check all Google Photos tabs for active scanning
 * This is called on popup initialization to restore state if popup was closed
 */
async function checkForActiveScanning() {
	try {
		// First check the current tab (most likely to be scanning)
		if (currentTab) {
			const found = await checkTabForScanning(currentTab);
			if (found) {
				return;
			}
		}

		// If not found, check all tabs
		const tabs = await chrome.tabs.query({});
		console.log('Checking for active scanning across', tabs.length, 'tabs');

		// Check each Google Photos tab for active scanning
		for (const tab of tabs) {
			const found = await checkTabForScanning(tab);
			if (found) {
				return; // Found it, no need to check others
			}
		}

		console.log('No active scanning found');
	} catch (error) {
		console.error('Error checking for active scanning:', error);
	}
}

/**
 * Poll for scanning status and update photo count in real-time
 */
function startStatusPolling() {
	let checkCounter = 0;

	setInterval(async () => {
		// If we know scanning is active, check the current tab frequently
		if (isProcessing && currentTab) {
			try {
				const response = await chrome.tabs.sendMessage(currentTab.id, {
					action: 'getScrapingStatus'
				});

				if (response) {
					if (!response.isActive && isProcessing) {
						// Scan finished
						isProcessing = false;
						showMessage('All done! Click "Review Duplicates" to see what we found.', 'success');
						// Refresh stats
						await loadStats();
						updateButtonStates();
					}

					// Update photo count in real-time during scanning
					if (response.isActive && response.progress) {
						const photoCount = response.progress.totalScraped || 0;
						document.getElementById('totalPhotos').textContent = photoCount;
					}
				}
			} catch {
				// Tab might have been closed or navigated away
				// Check all tabs again to find the scanning tab
				await checkForActiveScanning();
			}
		} else if (!isProcessing) {
			// Periodically check if scanning started on any tab
			// This handles the case where popup was closed and reopened
			// Check every 2 seconds (every 4th poll) to avoid excessive tab queries
			checkCounter++;
			if (checkCounter >= 4) {
				checkCounter = 0;
				await checkForActiveScanning();
			}
		}
	}, 500); // Poll twice per second for smoother updates
}
