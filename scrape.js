async function scrapeGooglePhotos(maxItemsToScrape = 50, itemFetchDelayMs = 100, pageScrollDelayMs = 2000, maxStaleScrolls = 5) {
    const scrapedItems = [];
    const processedItemIds = new Set();
    let staleScrollCount = 0;

    console.log(`Scraping up to ${maxItemsToScrape} items...`);

    // Helper for exponential backoff retries
    const retryOperationWithBackoff = async (operation, maxRetries = 5, baseDelayMs = 200, maxDelayMs = 60000) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const result = await operation();
                // If operation returns a "failure" state (e.g., null for fetch), consider retrying
                // Or if it throws, it will be caught below
                if (result === null || (result && result.status && result.status >= 500)) { // Example for http status > 500
                    throw new Error("Operation failed or returned null/error status, retrying...");
                }
                return result;
            } catch (error) {
                console.warn(`Attempt ${attempt + 1}/${maxRetries} failed: ${error.message}.`);
                if (attempt < maxRetries - 1) {
                    const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
                    console.log(`Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`Max retries (${maxRetries}) reached. Operation failed definitively.`);
                    throw error; // Re-throw the error after max retries
                }
            }
        }
    };

    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onload = () => resolve(fileReader.result.split(',')[1]);
        fileReader.onerror = reject;
        fileReader.readAsDataURL(blob);
    });

    const fetchImageAndConvertToBase64 = async (imageUrl) => {
        try {
            const response = await fetch(imageUrl, { credentials: 'include' });
            // Return null if response is not OK, this will trigger a retry via retryOperationWithBackoff
            if (!response.ok) {
                console.error(`Failed to fetch image ${imageUrl}: Status ${response.status}`);
                return null;
            }
            return { base64: await blobToBase64(await response.blob()) };
        } catch (error) {
            console.error(`Network error fetching image ${imageUrl}: ${error.message}`);
            throw error; // Re-throw to be caught by retryOperationWithBackoff
        }
    };

    const parseAriaLabel = (ariaLabel) => {
        let mediaType = 'Unknown',
            fileName = 'unknown',
            dateTaken = 'Unknown Date';

        if (!ariaLabel) {
            return { mediaType, fileName, dateTaken };
        }

        let match = ariaLabel.match(/^(Photo|Video)/);
        if (match) {
            mediaType = match[1];
        }

        let rawDateString = null;
        match = ariaLabel.match(/(\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}[ ⯠][AP]M)/); // Updated regex for U+202F (NARROW NO-BREAK SPACE)
        if (match) {
            rawDateString = match[1].replace('⯠', ' '); // Replace U+202F if found
        } else {
            match = ariaLabel.match(/(\w{3} \d{1,2}, \d{4})/);
            if (match) {
                rawDateString = match[1];
            }
        }

        if (rawDateString) {
            const dateObject = new Date(rawDateString);
            dateTaken = isNaN(dateObject) ? rawDateString : dateObject.toISOString();
        }

        const parts = ariaLabel.split(' - ');
        if (parts.length > 1 && parts[1].includes('.') && !['Portrait', 'Landscape'].includes(parts[1])) {
            fileName = parts[1];
        }

        return { mediaType, fileName, dateTaken };
    };

    const sendToIngestServer = async (itemPayload) => {
        try {
            const response = await fetch('http://localhost:8000/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(itemPayload)
            });
            console.log(`Ingest Status for ${itemPayload.id}: ${response.status}`);
            // If status is not 2xx, consider it a failure for retry purposes
            if (!response.ok) {
                throw new Error(`Ingest server returned status ${response.status}`);
            }
            return response; // Return response to indicate success
        } catch (error) {
            console.error(`Failed to POST ${itemPayload.id}:`, error.message);
            throw error; // Re-throw to be caught by retryOperationWithBackoff
        }
    };

    let scrollContainer = null;
    for (const selector of ['[jsname="xmrwfb"]', '[role="main"]']) {
        const element = document.querySelector(selector);
        if (element && element.scrollHeight > element.clientHeight) {
            scrollContainer = element;
            break;
        }
    }
    scrollContainer = scrollContainer || document.scrollingElement || document.documentElement;

    while (scrapedItems.length < maxItemsToScrape && staleScrollCount < maxStaleScrolls) {
        const initialItemCount = scrapedItems.length;

        for (const linkElement of document.querySelectorAll('a[href*="/photo/"]')) {
            if (scrapedItems.length >= maxItemsToScrape) {
                break;
            }

            const itemUrl = linkElement.href;
            const match = itemUrl.match(/\/photo\/(AF1Qip[a-zA-Z0-9_-]+)/);

            if (!match || processedItemIds.has(match[1])) {
                continue;
            }

            const itemId = match[1];
            processedItemIds.add(itemId);

            const ariaLabel = linkElement.getAttribute('aria-label') || '';
            const mediaMetadata = parseAriaLabel(ariaLabel);

            const imageOrDivElement = linkElement.querySelector('div[style*="background-image"],img');
            let imageUrl = imageOrDivElement ? imageOrDivElement.src || (imageOrDivElement.style.backgroundImage.match(/url\("(.+)"\)/) || [])[1] || '' : '';

            if (!imageUrl) {
                continue;
            }

            // Attempt to fetch image with retries
            let imageData = null;
            try {
                imageData = await retryOperationWithBackoff(() =>
                    fetchImageAndConvertToBase64(imageUrl.replace(/=[ws]\d+.*/, "=w400-h400-no"))
                );
            } catch (error) {
                console.error(`Skipping item ${itemId} due to persistent image fetch failure.`);
                continue; // Skip this item if image fetch fails after all retries
            }


            if (imageData) {
                const itemPayload = {
                    id: itemId,
                    mediaType: mediaMetadata.mediaType,
                    dateTaken: mediaMetadata.dateTaken,
                    base64: imageData.base64,
                    googlePhotosUrl: itemUrl
                };

                // Attempt to ingest data with retries
                try {
                    await retryOperationWithBackoff(() => sendToIngestServer(itemPayload));
                    scrapedItems.push(itemPayload);
                } catch (error) {
                    console.error(`Skipping item ${itemId} due to persistent ingest failure.`);
                    // Even if ingest fails, we don't remove from processedItemIds to avoid re-processing this specific item.
                    // This choice depends on desired error handling (e.g., could save failed items to a log instead).
                }
            }

            await new Promise(resolve => setTimeout(resolve, itemFetchDelayMs));
        }

        if (scrapedItems.length >= maxItemsToScrape) {
            break;
        }

        scrapedItems.length === initialItemCount ? staleScrollCount++ : staleScrollCount = 0;

        console.log(`Scrolling... (${scrapedItems.length}/${maxItemsToScrape})`);
        scrollContainer.scrollBy({ top: scrollContainer.clientHeight, behavior: 'smooth' });
        await new Promise(resolve => setTimeout(resolve, pageScrollDelayMs));
    }

    console.log(`--- COMPLETE: Scraped and sent ${scrapedItems.length} items. ---`);
}

scrapeGooglePhotos(20);