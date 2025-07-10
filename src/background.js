// background.js
// Main background script for the extension

/**
 * Pauses execution for a random amount of time to avoid overwhelming servers.
 * @param {number} minSeconds The minimum seconds to wait.
 * @param {number} maxSeconds The maximum seconds to wait.
 * @returns {Promise<void>}
 */
function delay(minSeconds, maxSeconds) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  console.log(`[Download] Waiting for ${Math.round(ms / 1000)}s...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}
// Responsible for scanning tabs, downloading images, and closing tabs if needed
// Beginner-friendly documentation included



// For development: use chrome.storage.local instead of chrome.storage.sync
// TODO: Switch back to chrome.storage.sync for production/cross-device sync

// Listen for extension startup or tab updates
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed and background script running.');
});

// Helper to send message to all popup views
function notifyPopupDownloadComplete() {
  if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage({ type: 'download-complete' });
    } catch (e) {
      console.warn('[Download] Could not notify popup (no popup open):', e);
    }
  }
}

// Helper to set download status in storage
function setDownloadStatus(inProgress, timestamp = null) {
  const update = { downloadInProgress: inProgress };
  if (!inProgress && timestamp) {
    update.lastDownloadComplete = timestamp;
  }
  chrome.storage.local.set(update);
}

// Sequential download with delay
async function downloadImagesSequentially(tabs, allowedSites, closeTabAfterDownload, folder) {
  setDownloadStatus(true);
  console.log('[Download] Starting sequential download process.');
  console.log('[Download] allowedSites:', allowedSites);
  if (!allowedSites.all_sites && Object.values(allowedSites).every(v => !v)) {
    console.warn('[Download] No domains are allowed in allowedSites! Check your settings.');
  }
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      const domain = url.hostname.replace(/^www\./, '').toLowerCase();
      const isAllowed = (allowedSites.all_sites === true) || (allowedSites[domain] === true);
      console.log(`[Download] Tab ${tab.id}: domain=${domain}, isAllowed=${isAllowed}`);
      if (isAllowed) {
        try {
          // Programmatically inject the content script to ensure it's available
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });

          console.log(`[Download] Sending 'find-main-image' to tab ${tab.id}`);
          // Send a message to the now-injected content script
          const response = await chrome.tabs.sendMessage(tab.id, {
            command: 'find-main-image',
          });

          if (response && response.status === 'found-image') {
            // If an image was found, download it
            await downloadImage(response.imageUrl, response.filename, settings, tab.id);
          } else {
            console.log(`[Download] No image found in tab ${tab.id}`);
          }
          // Always wait after a download attempt (even if no image found)
          await delay(1, 3);
        } catch (error) {
          // This error can happen on special browser pages (e.g., about:, chrome://)
          // where content script injection is not allowed.
          console.log(`[Download] Could not inject or communicate with tab ${tab.id}: ${error.message}`);
        }
      } else {
        console.log(`[Download] Skipping tab ${tab.id} (domain not allowed)`);
      }
    } catch (e) {
      console.warn(`[Download] Skipping tab (invalid URL): ${e}`);
    }
  }
  setDownloadStatus(false, Date.now());
  console.log('[Download] All downloads complete.');
  notifyPopupDownloadComplete();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Command from the popup to start scanning
  if (message.command === 'scan-all-tabs') {
    console.log('[Download] Received scan-all-tabs command.');
    // Explicitly get all settings from storage, falling back to defaults.
    chrome.storage.local.get(['folder', 'closeTabs', 'allowedSites'], (settings) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting settings:', chrome.runtime.lastError);
        return;
      }
      console.log('[Download] Loaded settings:', settings);
      // Provide a default for allowedSites if missing
      const allowedSites = settings.allowedSites || DEFAULT_SETTINGS.allowedSites;
      const closeTabAfterDownload = (typeof settings.closeTabs === 'boolean') ? settings.closeTabs : DEFAULT_SETTINGS.closeTabs;
      const folder = settings.folder || DEFAULT_SETTINGS.folder;
      chrome.tabs.query({}, (tabs) => {
        console.log(`[Download] Found ${tabs.length} tabs to scan.`);
        downloadImagesSequentially(tabs, allowedSites, closeTabAfterDownload, folder);
      });
    });
    return true; // Indicates an async response
  }

  // Command from the content script to download an image
  // Command from the content script to download an image.
  // This handler is marked 'async' to correctly handle promises.
  if (message.command === "download-image") {
    console.log(`[Download] Received download-image for URL: ${message.imageUrl}`);

    // This is the core of the fix. By wrapping the logic in an async IIFE (Immediately Invoked Function Expression),
    // we can use await and ensure the promise chain is handled correctly before the listener scope is lost.
    (async () => {
      try {
        // Only process download if the content script identified it as a main image view.
        if (!message.isMainImageView) {
          console.log('[Download] Skipping download: not a main image view.');
          sendResponse({ status: 'skipped', reason: 'not main image view' });
          return;
        }

        const settings = await chrome.storage.local.get(['folder', 'closeTabs', 'allowedSites']);
        const closeTabAfterDownload = (typeof settings.closeTabs === 'boolean') ? settings.closeTabs : DEFAULT_SETTINGS.closeTabs;
        const folder = settings.folder || DEFAULT_SETTINGS.folder;
        const allowedSites = settings.allowedSites || DEFAULT_SETTINGS.allowedSites;
        const filename = message.filename ? `${folder}/${message.filename}` : `${folder}/${Date.now()}.jpg`;

        // --- Duplicate Check ---
        // Before downloading, we'll check if a file with this exact name already exists.
        const existingDownloads = await chrome.downloads.search({ query: [message.filename], state: 'complete' });

        // The 'query' can be broad, so we must check if any result is an exact match inside the target folder.
        // The 'query' can be broad, so we must check if any result is an exact match inside the target folder
        // AND that the file actually still exists on the filesystem.
        const isDuplicate = existingDownloads.some(item => item.filename.endsWith(`/${folder}/${message.filename}`) && item.exists);

        if (isDuplicate) {
          console.log(`[Download] Skipping duplicate: ${message.filename} (already exists in '${folder}').`);
          sendResponse({ status: 'skipped', reason: 'duplicate' });
          return; // Stop here if it's a duplicate.
        }

        // Start the download.
        const downloadId = await chrome.downloads.download({
          url: message.imageUrl,
          filename: filename,
          conflictAction: "uniquify",
          saveAs: false
        });

        console.log(`[Download] Download started. Download ID: ${downloadId}, filename: ${filename}`);

        // If enabled, close the tab after the download has started.
        if (closeTabAfterDownload && sender.tab?.id) {
          await chrome.tabs.remove(sender.tab.id);
          console.log(`[Download] Closed tab ${sender.tab.id} after download.`);
        }

        sendResponse({ status: 'success', downloadId: downloadId });
      } catch (error) {
        console.error(`[Download] Error processing download: ${error.message}`);
        sendResponse({ status: 'error', message: error.message });
      }
    })();

    return true; // IMPORTANT: This tells Chrome to keep the message channel open for the async response.
  }
});

