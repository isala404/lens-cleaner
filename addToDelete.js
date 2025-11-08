async function processPhotosForDeletion(scrollDelayMs = 5341, apiRequestDelayMs = 150, maxStalePasses = 5) {
    console.log("--- Starting Photo Deletion Process ---");
    const allProcessedIds = new Set();
    let stalePassCount = 0;
    let selectedCount = 0;

    // --- 1. Find the scrollable container (Robust logic from previous script) ---
    const selectors = [
        '[jsname="bN97Pc"] .Purf9b', // Album view inner scroll area
        '[jsname="xmrwfb"]',        // Primary photos view main content area
        '[role="main"]',
    ];
    let scrollContainer = null;
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.scrollHeight > element.clientHeight) {
            scrollContainer = element;
            console.log(`Found scrollable container with selector: "${selector}"`);
            break;
        }
    }
    if (!scrollContainer) {
        scrollContainer = document.scrollingElement || document.documentElement;
        console.log("No specific container found, falling back to the main document.");
    }

    // --- 2. Main loop to scroll, check API, and select ---
    while (stalePassCount < maxStalePasses) {
        let newPhotosFoundInPass = false;

        // Find all photo container divs currently rendered in the DOM
        const photoContainers = document.querySelectorAll('div[jslog*="track:click; 8:"]');

        for (const container of photoContainers) {
            const jslog = container.getAttribute('jslog');
            const match = jslog.match(/8:(AF1Qip[a-zA-Z0-9_-]+)/);
            
            if (match && match[1]) {
                const photoId = match[1];

                // Skip this photo if we have already processed its ID
                if (allProcessedIds.has(photoId)) {
                    continue;
                }

                // We found a new photo, so we are not stale.
                newPhotosFoundInPass = true;
                allProcessedIds.add(photoId); // Mark as processed immediately

                const apiUrl = `http://localhost:8000/photos/${photoId}/deletion-status`;
                
                try {
                    console.log(`[CHECKING] ID: ${photoId}`);
                    const response = await fetch(apiUrl);

                    // --- Conditional Logic based on API response ---
                    if (response.status === 204) {
                        console.log(`[SELECTING] ID: ${photoId} (Status: 204)`);
                        const checkbox = container.querySelector('div.QcpS9c.ckGgle');
                        if (checkbox) {
                            checkbox.click();
                            selectedCount++;
                        } else {
                            console.warn(`Could not find checkbox for ID: ${photoId}`);
                        }
                    } else if (response.status === 202) {
                        console.log(`[SKIPPING] ID: ${photoId} (Status: 202)`);
                    } else {
                        console.warn(`[ERROR] ID: ${photoId} responded with unexpected Status: ${response.status}`);
                    }

                } catch (error) {
                    console.error(`[FATAL] Failed to fetch status for ID: ${photoId}. Error: ${error.message}`);
                }
                
                // Add a small delay between API requests
                await new Promise(resolve => setTimeout(resolve, apiRequestDelayMs));
            }
        }
        
        // --- Update Stale Pass Count ---
        if (newPhotosFoundInPass) {
            stalePassCount = 0; // Reset because we found new items
        } else {
            stalePassCount++;
            console.log(`No new photos found in this pass. Stale pass count: ${stalePassCount}/${maxStalePasses}`);
        }

        // Scroll down to load the next batch of photos
        scrollContainer.scrollBy({ top: scrollContainer.clientHeight, behavior: 'smooth' });
        await new Promise(resolve => setTimeout(resolve, scrollDelayMs));
    }

    // --- 3. Final Output ---
    console.log(`--- COMPLETE ---`);
    console.log(`Processed a total of ${allProcessedIds.size} unique photos.`);
    console.log(`Selected ${selectedCount} photos for deletion.`);
}

processPhotosForDeletion();