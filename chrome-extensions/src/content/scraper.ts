/**
 * Content script for scraping Google Photos
 * Runs on photos.google.com pages
 */

import { type Photo } from '../lib/db';

let isScrapingActive = false;
let scrapingProgress: {
	totalScraped: number;
	currentBatch: number;
	status: string;
} | null = null;

let isDeletionActive = false;
let deletionProgress: {
	total: number;
	selected: number;
	status: string;
	message: string;
} | null = null;

// Listen for messages from popup/service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log('📸 Lens Cleaner received message:', message.action);

	if (message.action === 'ping') {
		// Respond to ping to confirm content script is loaded
		sendResponse({ status: 'ready' });
	} else if (message.action === 'startScraping') {
		console.log('📸 Starting scraping with options:', message.options);
		startScraping(message.options || {});
		sendResponse({ status: 'started' });
	} else if (message.action === 'stopScraping') {
		stopScraping();
		sendResponse({ status: 'stopped' });
	} else if (message.action === 'getScrapingStatus') {
		sendResponse({
			isActive: isScrapingActive,
			progress: scrapingProgress
		});
	} else if (message.action === 'startDeletion') {
		console.log('🗑️ Starting deletion workflow with photo IDs:', message.photoIds);
		startDeletionWorkflow(message.photoIds || []);
		sendResponse({ status: 'started' });
	} else if (message.action === 'getDeletionStatus') {
		sendResponse({
			isActive: isDeletionActive,
			progress: deletionProgress
		});
	}
	return true; // Keep message channel open for async response
});

/**
 * Start the scraping process
 */
async function startScraping(options: { maxItems?: number; maxScrolls?: number } = {}) {
	console.log('📸 startScraping called, isScrapingActive:', isScrapingActive);

	if (isScrapingActive) {
		console.log('⚠️ Scraping already in progress');
		return;
	}

	const {
		maxItems = 1000,
		itemDelay = 100,
		scrollDelay = 2000,
		maxStaleScrolls = 5
	} = options as {
		maxItems?: number;
		itemDelay?: number;
		scrollDelay?: number;
		maxStaleScrolls?: number;
	};

	console.log('📸 Starting scraping with:', { maxItems, itemDelay, scrollDelay, maxStaleScrolls });

	isScrapingActive = true;
	scrapingProgress = {
		totalScraped: 0,
		currentBatch: 0,
		status: 'running'
	};

	// No overlay - progress shown in extension popup
	console.log('📸 Starting scraping...');

	try {
		// Scroll to the very top of the page before starting
		const scrollContainer = findScrollContainer();
		console.log('📸 Scrolling to top of page...');

		// Scroll to top immediately (instant) to ensure we're at the top
		scrollContainer.scrollTo({ top: 0, behavior: 'auto' });

		// Also try smooth scroll for better UX, but don't wait for it
		scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });

		// Wait for scroll to complete and page to settle
		await sleep(1500);

		// Double-check we're at the top
		if (scrollContainer.scrollTop > 0) {
			scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
			await sleep(500);
		}

		await scrapePhotos(maxItems, itemDelay, scrollDelay, maxStaleScrolls);
		scrapingProgress.status = 'completed';
	} catch (error) {
		console.error('Scraping error:', error);
		scrapingProgress.status = 'error';
	} finally {
		isScrapingActive = false;
	}
}

/**
 * Stop the scraping process
 */
function stopScraping() {
	isScrapingActive = false;
	if (scrapingProgress) {
		scrapingProgress.status = 'stopped';
	}
}

/**
 * Main scraping function
 */
async function scrapePhotos(
	maxItems: number,
	itemDelay: number,
	scrollDelay: number,
	maxStaleScrolls: number
) {
	const processedIds = new Set<string>();
	let staleScrollCount = 0;
	let totalScraped = 0;

	console.log(`Starting to scrape up to ${maxItems} photos...`);

	// Find scroll container
	const scrollContainer = findScrollContainer();

	while (totalScraped < maxItems && staleScrollCount < maxStaleScrolls && isScrapingActive) {
		const initialCount = totalScraped;
		const batch: Photo[] = [];

		// Find all photo links on the current viewport
		const photoLinks = document.querySelectorAll('a[href*="/photo/"]');

		for (const link of photoLinks) {
			if (totalScraped >= maxItems || !isScrapingActive) {
				break;
			}

			const photoData = await extractPhotoData(link as HTMLElement, processedIds);

			if (photoData) {
				batch.push(photoData);
				processedIds.add(photoData.id);
				totalScraped++;

				// Update progress
				scrapingProgress!.totalScraped = totalScraped;
				scrapingProgress!.currentBatch = batch.length;

				await sleep(itemDelay);
			}
		}

		// Send batch to service worker for storage
		if (batch.length > 0) {
			await sendBatchToServiceWorker(batch);
			console.log(`Sent batch of ${batch.length} photos to storage`);
		}

		// Check if we made progress
		if (totalScraped === initialCount) {
			staleScrollCount++;
		} else {
			staleScrollCount = 0;
		}

		// Stop if we reached the limit
		if (totalScraped >= maxItems) {
			break;
		}

		// Scroll down to load more photos
		console.log(`Scrolling... (${totalScraped}/${maxItems})`);
		scrollContainer.scrollBy({ top: scrollContainer.clientHeight, behavior: 'smooth' });
		await sleep(scrollDelay);
	}

	console.log(`Scraping complete: ${totalScraped} photos processed`);
	return totalScraped;
}

/**
 * Extract photo data from a link element
 */
async function extractPhotoData(linkElement: HTMLElement, processedIds: Set<string>) {
	try {
		// Extract photo ID from URL
		const photoUrl = (linkElement as HTMLAnchorElement).href;
		const match = photoUrl.match(/\/photo\/(AF1Qip[a-zA-Z0-9_-]+)/);

		if (!match || processedIds.has(match[1])) {
			return null;
		}

		const photoId = match[1];

		// Extract metadata from aria-label
		const ariaLabel = linkElement.getAttribute('aria-label') || '';
		const metadata = parseAriaLabel(ariaLabel);

		// Extract image URL
		const imageElement = linkElement.querySelector(
			'div[style*="background-image"],img'
		) as HTMLElement;
		if (!imageElement) {
			return null;
		}

		const imageUrl =
			(imageElement as HTMLImageElement).src ||
			(imageElement.style.backgroundImage.match(/url\("(.+)"\)/) || [])[1] ||
			'';

		if (!imageUrl) {
			return null;
		}

		// Fetch the image as blob
		const blob = await fetchImageAsBlob(imageUrl);

		if (!blob) {
			return null;
		}

		const photo: Photo = {
			id: photoId,
			blob: blob,
			mediaType: metadata.mediaType,
			dateTaken: metadata.dateTaken,
			timestamp: metadata.dateTaken ? new Date(metadata.dateTaken).getTime() : Date.now(),
			hasEmbedding: false,
			groupId: null
		};
		return photo;
	} catch (error) {
		console.error('Error extracting photo data:', error);
		return null;
	}
}

/**
 * Parse aria-label to extract metadata
 */
function parseAriaLabel(ariaLabel: string) {
	let mediaType = 'Photo';
	let dateTaken = new Date().toISOString();

	if (!ariaLabel) {
		return { mediaType, dateTaken };
	}

	// Extract media type
	const typeMatch = ariaLabel.match(/^(Photo|Video)/);
	if (typeMatch) {
		mediaType = typeMatch[1];
	}

	// Extract date
	let dateMatch = ariaLabel.match(/(\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}[\s⯠][AP]M)/);
	if (dateMatch) {
		const dateString = dateMatch[1].replace('⯠', ' ');
		const dateObject = new Date(dateString);
		if (!isNaN(dateObject.getTime())) {
			dateTaken = dateObject.toISOString();
		} else {
			console.warn(`Failed to parse date with time: "${dateString}" from aria-label: "${ariaLabel}"`);
		}
	} else {
		dateMatch = ariaLabel.match(/(\w{3} \d{1,2}, \d{4})/);
		if (dateMatch) {
			const dateObject = new Date(dateMatch[1]);
			if (!isNaN(dateObject.getTime())) {
				dateTaken = dateObject.toISOString();
			} else {
				console.warn(`Failed to parse date: "${dateMatch[1]}" from aria-label: "${ariaLabel}"`);
			}
		} else {
			console.warn(`No date found in aria-label: "${ariaLabel}"`);
		}
	}

	return { mediaType, dateTaken };
}

/**
 * Fetch image as blob
 */
async function fetchImageAsBlob(imageUrl: string): Promise<Blob | null> {
	try {
		// Request a smaller size for efficiency (400x400)
		const optimizedUrl = imageUrl.replace(/=[ws]\d+.*/, '=w400-h400-no');

		const response = await fetch(optimizedUrl, {
			credentials: 'include'
		});

		if (!response.ok) {
			console.error(`Failed to fetch image: ${response.status}`);
			return null;
		}

		return await response.blob();
	} catch (error) {
		console.error('Error fetching image:', error);
		return null;
	}
}

/**
 * Send batch of photos to service worker
 * Converts Blobs to ArrayBuffers for transmission, then reconstructs them in service worker
 */
async function sendBatchToServiceWorker(photos: Photo[]) {
	// Convert blobs to ArrayBuffers for transmission
	const photosWithArrayBuffers = await Promise.all(
		photos.map(async (photo) => {
			const blob = photo.blob;
			const arrayBuffer = await blob.arrayBuffer();
			const blobType = blob.type;
			const blobSize = blob.size;
			return {
				...photo,
				blob: null, // Remove blob (will be reconstructed in service worker)
				blobData: {
					arrayBuffer: Array.from(new Uint8Array(arrayBuffer)), // Convert to regular array for JSON serialization
					type: blobType,
					size: blobSize
				}
			};
		})
	);

	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(
			{
				action: 'storePhotos',
				photos: photosWithArrayBuffers
			},
			(response) => {
				if (chrome.runtime.lastError) {
					reject(chrome.runtime.lastError);
				} else {
					resolve(response);
				}
			}
		);
	});
}

/**
 * Find the scrollable container
 */
function findScrollContainer(): Element {
	// Try different selectors for Google Photos
	// Album view inner scroll area is checked first (for deletion workflow)
	const selectors = [
		'[jsname="bN97Pc"] .Purf9b', // Album view inner scroll area
		'[jsname="xmrwfb"]', // Primary photos view main content area
		'[role="main"]'
	];

	for (const selector of selectors) {
		const element = document.querySelector(selector);
		if (element && element.scrollHeight > element.clientHeight) {
			console.log(`Found scrollable container with selector: "${selector}"`);
			return element;
		}
	}

	// Fallback to document scrolling
	console.log('No specific container found, falling back to the main document.');
	return document.scrollingElement || document.documentElement;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deletion Workflow Functions
 */

async function startDeletionWorkflow(photoIds: string[]) {
	if (isDeletionActive) {
		console.log('⚠️ Deletion workflow already in progress');
		return;
	}

	isDeletionActive = true;
	deletionProgress = {
		total: photoIds.length,
		selected: 0,
		status: 'running',
		message: 'Initializing...'
	};

	showDeletionProgressBanner();

	try {
		// Check if we're on the albums page
		if (!window.location.href.includes('photos.google.com/albums')) {
			updateDeletionProgress('Please navigate to the albums page', 0);
			await sleep(2000);
			isDeletionActive = false;
			hideDeletionProgressBanner();
			return;
		}

		// Step 1: Click create album button
		updateDeletionProgress('Looking for create album button...', 0);
		await sleep(1000);

		const createButton = document.querySelector(
			'c-wiz > div.h8plyb.HnzzId > c-wiz > div > div.eReC4e.FbgB9 > div > div > div.DNAsC.G6iPcb.aSMlbb > span > button > div'
		) as HTMLElement;
		if (!createButton) {
			updateDeletionProgress('Error: Could not find create album button', 0);
			await sleep(3000);
			isDeletionActive = false;
			hideDeletionProgressBanner();
			return;
		}

		updateDeletionProgress('Clicking create album button...', 0);
		createButton.click();
		await sleep(2000);

		// Step 2: Click to add images view
		updateDeletionProgress('Opening add images view...', 0);
		await sleep(5000);
		const addImagesButton = document.querySelector(
			'div > div.yKzHyd > span > div > div > div:nth-child(2) > div > div > div.FHHhzf > div:nth-child(3) > div > div > div'
		) as HTMLElement;
		if (!addImagesButton) {
			updateDeletionProgress('Error: Could not find add images button', 0);
			await sleep(3000);
			isDeletionActive = false;
			hideDeletionProgressBanner();
			return;
		}

		addImagesButton.click();
		await sleep(5000);

		// Step 3: Select photos marked for deletion
		updateDeletionProgress('Searching for photos to delete...', 0);
		await selectPhotosForDeletion(photoIds);

		// Step 4: Click Done button
		updateDeletionProgress('Saving album...', deletionProgress.selected);
		await sleep(1000);

		const doneButton = document.querySelector(
			'#yDmH0d > div.uW2Fw-Sx9Kwc.uW2Fw-qON5Qe-FoKg4d-Sx9Kwc-fZiSAe.yaahMe.V639qd.uW2Fw-Sx9Kwc-OWXEXe-n9oEIb.jap5td.UIMz.QaJAKf.uW2Fw-Sx9Kwc-OWXEXe-FNFY6c > div.uW2Fw-wzTsW.O4g5Md.RsAcmc.iWO5td > div > div > div > div > div > div > div.JzcJRd.oM5Pic > span > div.nyu5jc > div:nth-child(2) > button'
		) as HTMLElement;
		if (doneButton) {
			doneButton.click();
			await sleep(2000);
		}

		const albumTitle = document.querySelector(
			'div > div.mIFvyc > div > div.AUyNN > div > div.Yyy4Hc > div > textarea'
		) as HTMLTextAreaElement;
		if (albumTitle) {
			albumTitle.value = 'TO_BE_DELETE_' + new Date().toISOString();
			albumTitle.dispatchEvent(new Event('input', { bubbles: true }));
		}

		// Step 5: Show completion message
		updateDeletionProgress(
			`Album created with ${deletionProgress.selected} photos! Please review and delete them.`,
			deletionProgress.selected
		);
		deletionProgress.status = 'completed';
		await sleep(5000);
	} catch (error) {
		console.error('Deletion workflow error:', error);
		updateDeletionProgress('Error during deletion workflow', deletionProgress?.selected || 0);
		deletionProgress!.status = 'error';
		await sleep(3000);
	} finally {
		isDeletionActive = false;
		hideDeletionProgressBanner();
	}
}

async function selectPhotosForDeletion(photoIds: string[]) {
	const scrollContainer = findScrollContainer();
	let selectedCount = 0;
	let staleScrollCount = 0;
	const maxStaleScrolls = 5;
	const scrollDelay = 2000;
	const apiRequestDelay = 150;

	// Track all photo IDs we've seen (to avoid processing twice)
	const processedIds = new Set<string>();

	// Track which target photo IDs we still need to find
	const remainingPhotoIds = new Set(photoIds);

	updateDeletionProgress(`Selecting photos (0/${photoIds.length})...`, 0);

	while (staleScrollCount < maxStaleScrolls && remainingPhotoIds.size > 0) {
		let foundNewPhotosInPass = false;

		// Find all photo containers currently rendered
		const photoContainers = document.querySelectorAll('div[jslog*="track:click; 8:"]');

		for (const container of photoContainers) {
			const jslog = container.getAttribute('jslog');
			const match = jslog?.match(/8:(AF1Qip[a-zA-Z0-9_-]+)/);

			if (match && match[1]) {
				const photoId = match[1];

				// Skip if already processed this photo ID
				if (processedIds.has(photoId)) {
					continue;
				}

				// Mark as processed
				processedIds.add(photoId);
				foundNewPhotosInPass = true;

				// Check if this photo is in our target list
				if (remainingPhotoIds.has(photoId)) {
					console.log(`[SELECTING] ID: ${photoId}`);
					const checkbox = container.querySelector('div.QcpS9c.ckGgle') as HTMLElement;
					if (checkbox) {
						checkbox.click();
						selectedCount++;
						remainingPhotoIds.delete(photoId);
						updateDeletionProgress(
							`Selecting photos (${selectedCount}/${photoIds.length})... ${remainingPhotoIds.size} remaining`,
							selectedCount
						);
						await sleep(apiRequestDelay);
					} else {
						console.warn(`Could not find checkbox for ID: ${photoId}`);
					}
				}
			}
		}

		// Update stale scroll count based on whether we found new photos
		if (foundNewPhotosInPass) {
			staleScrollCount = 0; // Reset because we found new items
		} else {
			staleScrollCount++;
			console.log(
				`No new photos found in this pass. Stale pass count: ${staleScrollCount}/${maxStaleScrolls}`
			);
		}

		// Stop if we selected all target photos
		if (remainingPhotoIds.size === 0) {
			console.log(`All ${photoIds.length} target photos have been selected!`);
			break;
		}

		// Scroll down to load more photos
		scrollContainer.scrollBy({ top: scrollContainer.clientHeight, behavior: 'smooth' });
		await sleep(scrollDelay);
	}

	// Log final results
	console.log(`--- SELECTION COMPLETE ---`);
	console.log(`Processed a total of ${processedIds.size} unique photos.`);
	console.log(`Selected ${selectedCount} photos for deletion.`);
	if (remainingPhotoIds.size > 0) {
		console.warn(`Could not find ${remainingPhotoIds.size} photos:`, Array.from(remainingPhotoIds));
	}

	deletionProgress!.selected = selectedCount;
}

function showDeletionProgressBanner() {
	// Remove existing banner if any
	hideDeletionProgressBanner();

	const banner = document.createElement('div');
	banner.id = 'lens-cleaner-deletion-banner';
	banner.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 20px 24px;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    min-width: 320px;
    max-width: 400px;
    backdrop-filter: blur(10px);
    border: 2px solid rgba(255, 255, 255, 0.3);
  `;

	banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
      <div class="spinner" style="
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      "></div>
      <div style="font-size: 16px; font-weight: 600;">🗑️ Lens Cleaner</div>
    </div>
    <div id="deletion-progress-message" style="font-size: 13px; opacity: 0.95; margin-left: 28px;">
      Initializing...
    </div>
    <div id="deletion-progress-count" style="font-size: 12px; opacity: 0.85; margin-left: 28px; margin-top: 4px;">
      0 photos selected
    </div>
    <style>
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  `;

	document.body.appendChild(banner);
}

function updateDeletionProgress(message: string, count: number) {
	const messageElement = document.getElementById('deletion-progress-message');
	if (messageElement) {
		messageElement.textContent = message;
	}

	const countElement = document.getElementById('deletion-progress-count');
	if (countElement) {
		countElement.textContent = `${count} photos selected`;
	}

	if (deletionProgress) {
		deletionProgress.message = message;
		deletionProgress.selected = count;
	}
}

function hideDeletionProgressBanner() {
	const banner = document.getElementById('lens-cleaner-deletion-banner');
	if (banner) {
		banner.remove();
	}
}

console.log('📸 Lens Cleaner content script loaded and ready!');
console.log('📸 Waiting for startScraping message...');
