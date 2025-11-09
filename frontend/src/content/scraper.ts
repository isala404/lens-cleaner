/**
 * Content script for scraping Google Photos
 * Runs on photos.google.com pages
 */

let isScrapingActive = false;
let scrapingProgress: {
  totalScraped: number;
  currentBatch: number;
  status: string;
} | null = null;

// Listen for messages from popup/service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📸 Lens Cleaner received message:', message.action);

  if (message.action === 'startScraping') {
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
  }
  return true; // Keep message channel open for async response
});

/**
 * Start the scraping process
 */
async function startScraping(options: any = {}) {
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
  } = options;

  console.log('📸 Starting scraping with:', { maxItems, itemDelay, scrollDelay, maxStaleScrolls });

  isScrapingActive = true;
  scrapingProgress = {
    totalScraped: 0,
    currentBatch: 0,
    status: 'running'
  };

  // Show progress overlay
  console.log('📸 Showing progress overlay...');
  showProgressOverlay();

  try {
    await scrapePhotos(maxItems, itemDelay, scrollDelay, maxStaleScrolls);
    scrapingProgress.status = 'completed';
    updateProgressOverlay(`✓ Complete! Scraped ${scrapingProgress.totalScraped} photos`);
  } catch (error) {
    console.error('Scraping error:', error);
    scrapingProgress.status = 'error';
    updateProgressOverlay(`✗ Error: ${(error as Error).message}`);
  } finally {
    isScrapingActive = false;
    setTimeout(() => hideProgressOverlay(), 3000);
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
  updateProgressOverlay('Scraping stopped by user');
  setTimeout(() => hideProgressOverlay(), 2000);
}

/**
 * Main scraping function
 */
async function scrapePhotos(maxItems: number, itemDelay: number, scrollDelay: number, maxStaleScrolls: number) {
  const processedIds = new Set<string>();
  let staleScrollCount = 0;
  let totalScraped = 0;

  console.log(`Starting to scrape up to ${maxItems} photos...`);

  // Find scroll container
  const scrollContainer = findScrollContainer();

  while (totalScraped < maxItems && staleScrollCount < maxStaleScrolls && isScrapingActive) {
    const initialCount = totalScraped;
    const batch: any[] = [];

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

        // Update progress every 10 photos
        if (totalScraped % 10 === 0) {
          scrapingProgress!.totalScraped = totalScraped;
          scrapingProgress!.currentBatch = batch.length;
          updateProgressOverlay(`Scraped ${totalScraped} photos...`);
        }

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
    const imageElement = linkElement.querySelector('div[style*="background-image"],img') as HTMLElement;
    if (!imageElement) {
      return null;
    }

    let imageUrl = (imageElement as HTMLImageElement).src ||
      ((imageElement.style.backgroundImage.match(/url\("(.+)"\)/) || [])[1]) || '';

    if (!imageUrl) {
      return null;
    }

    // Fetch the image and convert to base64
    const base64 = await fetchImageAsBase64(imageUrl);

    if (!base64) {
      return null;
    }

    return {
      id: photoId,
      base64: base64,
      mediaType: metadata.mediaType,
      dateTaken: metadata.dateTaken,
      googlePhotosUrl: photoUrl
    };
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
    }
  } else {
    dateMatch = ariaLabel.match(/(\w{3} \d{1,2}, \d{4})/);
    if (dateMatch) {
      const dateObject = new Date(dateMatch[1]);
      if (!isNaN(dateObject.getTime())) {
        dateTaken = dateObject.toISOString();
      }
    }
  }

  return { mediaType, dateTaken };
}

/**
 * Fetch image and convert to base64
 */
async function fetchImageAsBase64(imageUrl: string): Promise<string | null> {
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

    const blob = await response.blob();
    return await blobToBase64(blob);
  } catch (error) {
    console.error('Error fetching image:', error);
    return null;
  }
}

/**
 * Convert blob to base64
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Remove the data:image/...;base64, prefix
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Send batch of photos to service worker
 */
async function sendBatchToServiceWorker(photos: any[]) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: 'storePhotos',
        photos: photos
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
  const selectors = ['[jsname="xmrwfb"]', '[role="main"]'];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.scrollHeight > element.clientHeight) {
      return element;
    }
  }

  // Fallback to document scrolling
  return document.scrollingElement || document.documentElement;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * UI Overlay Functions
 */
function showProgressOverlay() {
  // Remove existing overlay if any
  hideProgressOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'lens-cleaner-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 20px 30px;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    min-width: 250px;
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.2);
  `;

  overlay.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <div class="spinner" style="
        width: 20px;
        height: 20px;
        border: 3px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      "></div>
      <div id="lens-cleaner-message">Initializing...</div>
    </div>
    <style>
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  `;

  document.body.appendChild(overlay);
}

function updateProgressOverlay(message: string) {
  const messageElement = document.getElementById('lens-cleaner-message');
  if (messageElement) {
    messageElement.textContent = message;
  }
}

function hideProgressOverlay() {
  const overlay = document.getElementById('lens-cleaner-overlay');
  if (overlay) {
    overlay.remove();
  }
}

console.log('📸 Lens Cleaner content script loaded and ready!');
console.log('📸 Waiting for startScraping message...');
