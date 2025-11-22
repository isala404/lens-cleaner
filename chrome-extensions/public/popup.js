/**
 * Popup JavaScript - State Machine Approach
 * Reliable, clean, and explicit state management
 */

// State definitions
const STATES = {
	LOADING: 'LOADING',
	NOT_ON_GOOGLE_PHOTOS: 'NOT_ON_GOOGLE_PHOTOS',
	IDLE_NO_DATA: 'IDLE_NO_DATA',
	IDLE_WITH_DATA: 'IDLE_WITH_DATA',
	SCANNING: 'SCANNING'
};

// Global App State
let appState = {
	current: STATES.LOADING,
	stats: {
		totalPhotos: 0,
		totalGroups: 0
	},
	currentTab: null,
	error: null
};

// DOM Elements
const elements = {};

// Timeout for messages
let messageTimeout = null;

/**
 * Track event with Umami
 */
function trackEvent(eventName, data = {}) {
	if (window.umami) {
		window.umami.track(eventName, data);
	}
}

/**
 * Initialize on load
 */
document.addEventListener('DOMContentLoaded', async () => {
	trackEvent('Popup Opened');

	// Cache DOM elements
	cacheElements();

	// Initial render
	render();

	// Setup listeners
	setupEventListeners();

	// Load initial data
	await refreshState();

	// Start polling loop (lighter weight, just checks if state needs updates)
	startPolling();
});

/**
 * Cache DOM elements for performance
 */
function cacheElements() {
	const ids = [
		'loadingView',
		'notOnGooglePhotos',
		'onGooglePhotos',
		'totalPhotos',
		'totalGroups',
		'groupsRow',
		'startScan',
		'clearData',
		'openDashboard',
		'message',
		'openGooglePhotos'
	];

	ids.forEach((id) => {
		elements[id] = document.getElementById(id);
	});
}

/**
 * Main State Refresher
 * Fetches all necessary data and determines the correct state
 */
async function refreshState() {
	try {
		// 1. Get Current Tab
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		appState.currentTab = tab;

		// 2. Get Stats from Service Worker
		const statsResponse = await chrome.runtime.sendMessage({ action: 'getStats' });
		if (statsResponse && statsResponse.success) {
			appState.stats.totalPhotos = statsResponse.stats.totalPhotos || 0;
			appState.stats.totalGroups = statsResponse.stats.totalGroups || 0;
		}

		// 3. Check for Active Scanning (Tab Level)
		const isScanning = await checkActiveScanning(tab);

		// 4. Determine State
		determineState(isScanning);
	} catch (error) {
		console.error('Error refreshing state:', error);
		appState.error = error.message;
		// Fallback to loading or error state if needed, but usually we can recover
	} finally {
		render();
	}
}

/**
 * Determine the application state based on data
 */
function determineState(isScanning) {
	const isPhotosTab =
		appState.currentTab &&
		appState.currentTab.url &&
		appState.currentTab.url.includes('photos.google.com');

	const hasData = appState.stats.totalPhotos > 0;

	if (isScanning) {
		appState.current = STATES.SCANNING;
	} else if (!isPhotosTab && !hasData) {
		// If not on photos and no data, prompt to open photos
		appState.current = STATES.NOT_ON_GOOGLE_PHOTOS;
	} else if (hasData) {
		// If we have data, we show the dashboard/review UI regardless of tab
		// (allows reviewing duplicates from any tab)
		appState.current = STATES.IDLE_WITH_DATA;
	} else if (isPhotosTab && !hasData) {
		appState.current = STATES.IDLE_NO_DATA;
	} else {
		// Fallback
		appState.current = STATES.NOT_ON_GOOGLE_PHOTOS;
	}
}

/**
 * Check if scanning is active on the current tab or any tab
 */
async function checkActiveScanning(currentTab) {
	// First check current tab if it's Google Photos
	if (currentTab && currentTab.url && currentTab.url.includes('photos.google.com')) {
		const status = await getTabScanningStatus(currentTab.id);
		if (status.isActive) {
			// Update stats from live progress if available
			if (status.progress) {
				appState.stats.totalPhotos = status.progress.totalScraped;
			}
			return true;
		}
	}

	// If not found on current tab, we might want to check others
	// But for simplicity and performance, we primarily trust the current tab
	// or rely on the user navigating to the scanning tab.
	// However, to be safe, if we think we are scanning but current tab isn't,
	// we could do a broader search. For now, let's stick to current tab for "Active" scanning UI.
	return false;
}

/**
 * Helper to get status from a specific tab safely
 */
async function getTabScanningStatus(tabId) {
	try {
		// Ping first to ensure script is there
		try {
			await chrome.tabs.sendMessage(tabId, { action: 'ping' });
		} catch {
			// If ping fails, try to inject (only if we are fairly sure it's needed)
			// For checking status, we might just return false if script isn't there
			return { isActive: false };
		}

		const response = await chrome.tabs.sendMessage(tabId, { action: 'getScrapingStatus' });
		return response || { isActive: false };
	} catch {
		return { isActive: false };
	}
}

/**
 * Render the UI based on current state
 */
function render() {
	console.log('Rendering State:', appState.current);

	// Hide all main views first
	elements.loadingView.classList.add('hidden');
	elements.notOnGooglePhotos.classList.add('hidden');
	elements.onGooglePhotos.classList.add('hidden');
	elements.groupsRow.classList.add('hidden');

	// Update Stats
	elements.totalPhotos.textContent = appState.stats.totalPhotos;
	elements.totalGroups.textContent = appState.stats.totalGroups;

	// Reset Button Classes (remove specific state classes)
	resetButtonStyles();

	switch (appState.current) {
		case STATES.LOADING:
			elements.loadingView.classList.remove('hidden');
			break;

		case STATES.NOT_ON_GOOGLE_PHOTOS:
			elements.notOnGooglePhotos.classList.remove('hidden');
			break;

		case STATES.IDLE_NO_DATA:
			elements.onGooglePhotos.classList.remove('hidden');
			elements.startScan.classList.remove('hidden');
			elements.startScan.textContent = '🔍 Find Duplicates';
			elements.startScan.classList.add('btn-success');

			elements.clearData.classList.add('hidden');
			elements.openDashboard.style.display = 'none';
			break;

		case STATES.IDLE_WITH_DATA:
			elements.onGooglePhotos.classList.remove('hidden');
			elements.groupsRow.classList.remove('hidden');

			// Show Review Button
			elements.openDashboard.style.display = 'block';
			elements.openDashboard.classList.add('btn-success');
			elements.openDashboard.textContent = '📊 Review Duplicates';

			// Show Clear Button
			elements.clearData.classList.remove('hidden');

			// Hide Scan Button (or make it secondary "Rescan"?)
			// User requested "less is more". Hiding scan button when data exists prevents confusion.
			// They should clear data to restart.
			elements.startScan.classList.add('hidden');
			break;

		case STATES.SCANNING:
			elements.onGooglePhotos.classList.remove('hidden');

			// Scan Button becomes Stop Button
			elements.startScan.classList.remove('hidden');
			elements.startScan.textContent = '⏹ Stop Scanning';
			elements.startScan.classList.add('btn-danger');

			// Hide other controls during scan
			elements.clearData.classList.add('hidden');
			elements.openDashboard.style.display = 'none';

			// Show warning message persistently (duration = 0)
			showMessage('⚠️ Keep this window open while scanning!', 'info', 0);
			break;
	}
}

function resetButtonStyles() {
	const btns = [elements.startScan, elements.openDashboard];
	btns.forEach((btn) => {
		if (btn) {
			btn.className = 'btn'; // Reset to base class
			// We will add specific classes in render switch
		}
	});
}

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
	// Open Google Photos
	elements.openGooglePhotos.addEventListener('click', () => {
		trackEvent('Open Google Photos');
		chrome.tabs.create({ url: 'https://photos.google.com', active: true });
	});

	// Start/Stop Scan
	elements.startScan.addEventListener('click', async () => {
		if (appState.current === STATES.SCANNING) {
			await handleStopScan();
		} else {
			await handleStartScan();
		}
	});

	// Open Dashboard
	elements.openDashboard.addEventListener('click', () => {
		trackEvent('Open Dashboard');
		chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
	});

	// Clear Data
	elements.clearData.addEventListener('click', handleClearData);
}

/**
 * Action: Start Scan
 */
async function handleStartScan() {
	if (!appState.currentTab) return;

	try {
		// Ensure script loaded
		const loaded = await ensureContentScriptLoaded(appState.currentTab.id);
		if (!loaded) {
			showMessage('Please refresh the page and try again.', 'error');
			return;
		}

		// Send Start Message
		await chrome.tabs.sendMessage(appState.currentTab.id, {
			action: 'startScraping',
			options: {
				maxItems: Number.MAX_SAFE_INTEGER,
				itemDelay: 100,
				scrollDelay: 2000,
				maxStaleScrolls: 5
			}
		});

		// Optimistic Update
		appState.current = STATES.SCANNING;
		trackEvent('Start Scan', { tabId: appState.currentTab.id });
		render();
	} catch (error) {
		console.error('Start scan failed:', error);
		showMessage('Failed to start scan.', 'error');
	}
}

/**
 * Action: Stop Scan
 */
async function handleStopScan() {
	if (!appState.currentTab) return;

	try {
		await chrome.tabs.sendMessage(appState.currentTab.id, { action: 'stopScraping' });
		// State will update on next poll/refresh
		showMessage('Stopping scan...', 'info');
		trackEvent('Stop Scan');
		setTimeout(refreshState, 500);
	} catch (error) {
		console.error('Stop scan failed:', error);
	}
}

/**
 * Action: Clear Data
 */
async function handleClearData() {
	if (!confirm('Are you sure you want to clear all data and start fresh?')) return;

	try {
		// First attempt without force to check for paid features/AI suggestions
		let response = await chrome.runtime.sendMessage({ action: 'clearAllData', force: false });

		// If server says we need confirmation (due to paid features being present)
		if (response && response.requiresConfirmation) {
			const userTyped = prompt(
				'⚠️ WARNING: You have AI suggestions (Paid Feature) that will be lost!\n\nType "I understand" to confirm clearing all data:'
			);

			if (userTyped && userTyped.toLowerCase() === 'i understand') {
				// Retry with force
				response = await chrome.runtime.sendMessage({ action: 'clearAllData', force: true });
			} else {
				showMessage('Clear cancelled.', 'info');
				return;
			}
		}

		if (response && response.success) {
			// Clean local state
			appState.stats.totalPhotos = 0;
			appState.stats.totalGroups = 0;

			// Force refresh
			await refreshState();
			showMessage('Data cleared!', 'success');
			trackEvent('Clear Data');
		} else {
			throw new Error(response?.error || 'Unknown error');
		}
	} catch (error) {
		console.error('Clear data failed:', error);
		showMessage('Failed to clear data.', 'error');
	}
}

/**
 * Helper: Ensure Content Script Loaded
 */
async function ensureContentScriptLoaded(tabId) {
	try {
		await chrome.tabs.sendMessage(tabId, { action: 'ping' });
		return true;
	} catch {
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tabId },
				files: ['content-scraper.js']
			});
			await new Promise((r) => setTimeout(r, 500)); // Wait for init
			return true;
		} catch (e) {
			console.error('Script injection failed:', e);
			return false;
		}
	}
}

/**
 * Helper: Show Flash Message
 * @param {string} text - Message text
 * @param {string} type - 'info', 'success', 'error'
 * @param {number} duration - Duration in ms, 0 for persistent
 */
function showMessage(text, type = 'info', duration = 3000) {
	const msg = elements.message;

	// Clear any existing timeout to prevent race conditions
	if (messageTimeout) {
		clearTimeout(messageTimeout);
		messageTimeout = null;
	}

	msg.textContent = text;
	msg.className = `message ${type}`;
	msg.classList.remove('hidden');

	// Only set timeout if duration > 0 and not an error
	// (Errors usually stay longer or require explicit dismissal, but here we stick to duration)
	if (duration > 0 && type !== 'error') {
		messageTimeout = setTimeout(() => {
			msg.classList.add('hidden');
			messageTimeout = null;
		}, duration);
	} else if (duration > 0 && type === 'error') {
		// Errors stay for 5s by default logic or until next message
		messageTimeout = setTimeout(() => {
			msg.classList.add('hidden');
			messageTimeout = null;
		}, 5000);
	}
}

/**
 * Polling Loop
 * Keeps UI in sync during scanning
 */
function startPolling() {
	setInterval(() => {
		if (appState.current === STATES.SCANNING) {
			refreshState();
		}
	}, 1000);
}
