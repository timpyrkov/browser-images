// background.js
// Main background script for the extension

// In Chrome service workers defaults.js must be loaded explicitly.
// In Firefox background scripts it is loaded before this file by the manifest.
if (typeof importScripts === 'function') {
  importScripts('defaults.js', 'naming.js', 'galleries.js', 'galleries/deviantart.js', 'galleries/pinterest.js');
}

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

// Broadcast progress/state messages to any open sidebar views.
function broadcast(type, item = {}) {
  try {
    chrome.runtime.sendMessage({ type, item }).catch(() => {
      // No receiving sidebar open; ignore.
    });
  } catch (e) {
    // Extension context invalidated, etc.
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

function waitForDownloadComplete(downloadId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let timer = null;

    function cleanup() {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
    }

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        resolve();
      }
      if (delta.error?.current) {
        cleanup();
        reject(new Error(delta.error.current));
      }
    }

    chrome.downloads.onChanged.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Download completion timeout'));
    }, timeoutMs);
  });
}

function sanitizeSubfolder(subfolder) {
  if (!subfolder) return '';
  return subfolder
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\.{2,}[/\\]?/g, '')
    .replace(/\s+/g, '_');
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv']);

function normalizeExtension(ext) {
  if (!ext) return '';
  const lower = ext.toLowerCase();
  if (lower === 'jpeg') return 'jpg';
  if (lower === 'pjpeg' || lower === 'pjp') return 'jpg';
  if (lower === 'tif') return 'tiff';
  return lower;
}

function isVideoFilename(filename) {
  const ext = filename.split('.').pop();
  return VIDEO_EXTENSIONS.has(normalizeExtension(ext));
}

function pickSubfolder(filename, galleryPath) {
  if (isVideoFilename(filename)) {
    return galleryPath?.videos || 'MOV';
  }
  return galleryPath?.images || 'PIC';
}

function buildFilename(filename, subfolder) {
  const clean = sanitizeSubfolder(subfolder);
  if (!clean) return filename;
  return `${clean}/${filename}`;
}

// Download a single image into the configured folder.
// `skipDownloaded` controls the duplicate check against download history.
async function downloadImage(imageUrl, filename, targetFolderArg, skipDownloaded) {
  try {
    if (!imageUrl) {
      return { status: 'error', message: 'No image URL provided' };
    }

    const targetFolder = sanitizeSubfolder(targetFolderArg);
    const fullFilename = filename
      ? buildFilename(filename, targetFolder)
      : buildFilename(`${Date.now()}.jpg`, targetFolder);

    if (skipDownloaded && filename) {
      // Duplicate check based on browser download history.
      const existingDownloads = await chrome.downloads.search({ query: [filename], state: 'complete' });
      const targetSuffix = targetFolder ? `/${targetFolder}/${filename}` : `/${filename}`;
      const isDuplicate = existingDownloads.some(item => item.filename && item.filename.endsWith(targetSuffix));

      if (isDuplicate) {
        console.log(`[Download] Skipping duplicate: ${filename} (already exists).`);
        return { status: 'skipped', reason: 'duplicate' };
      }
    }

    const downloadId = await chrome.downloads.download({
      url: imageUrl,
      filename: fullFilename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    if (!downloadId) {
      return { status: 'error', message: 'Download was cancelled or blocked by the browser' };
    }

    console.log(`[Download] Download started. Download ID: ${downloadId}, filename: ${fullFilename}`);

    return { status: 'success', downloadId };
  } catch (error) {
    console.error(`[Download] Error downloading ${filename}: ${error.message}`);
    return { status: 'error', message: error.message };
  }
}

function logItem(tab, status, extra = {}) {
  return {
    id: tab.id,
    url: tab.url,
    title: extra.title || tab.title || tab.url,
    filename: extra.filename || '',
    thumbUrl: extra.thumbUrl || '',
    status,
    // Images in this tab with the reported status, and how many were found in
    // total. The sidebar renders these as "Downloaded (6)" / "Downloading (2/6)".
    count: extra.count || 0,
    total: extra.total || 0,
    reason: extra.reason || '',
    message: extra.message || '',
    timestamp: Date.now(),
  };
}

/**
 * Download every image found in one tab and report a single aggregated log
 * row for that tab. A tab counts as downloaded when at least one of its
 * images landed, so a partly-duplicate tab still reads as a success.
 */
async function downloadTabImages(tab, response, galleryPath, delaySeconds, skipDownloaded) {
  const images = response.images;
  const allNames = images.map((image) => image.filename).join(', ');
  const counts = { downloaded: 0, skipped: 0, error: 0 };
  let thumbUrl = '';
  let lastReason = '';
  let lastMessage = '';

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    broadcast('download-progress', logItem(tab, 'downloading', {
      title: response.title,
      filename: image.filename,
      thumbUrl: thumbUrl || image.imageUrl,
      count: i + 1,
      total: images.length,
    }));

    const targetFolder = pickSubfolder(image.filename, galleryPath);
    const result = await downloadImage(image.imageUrl, image.filename, targetFolder, skipDownloaded);

    if (result.status === 'success') {
      counts.downloaded++;
      if (!thumbUrl) thumbUrl = image.imageUrl;
      await delay(delaySeconds, delaySeconds);
    } else if (result.status === 'skipped') {
      counts.skipped++;
      lastReason = result.reason;
      console.log(`[Download] Skipped ${image.filename} in tab ${tab.id}: ${result.reason}`);
    } else {
      counts.error++;
      lastMessage = result.message;
      console.error(`[Download] Error for ${image.filename} in tab ${tab.id}: ${result.message}`);
    }
  }

  const status = counts.downloaded ? 'downloaded' : (counts.skipped ? 'skipped' : 'error');
  broadcast('download-progress', logItem(tab, status, {
    title: response.title,
    filename: allNames,
    thumbUrl: thumbUrl || images[0].imageUrl,
    count: counts[status],
    total: images.length,
    reason: lastReason,
    message: lastMessage,
  }));
}

// Sequential download with delay
async function downloadImagesSequentially(tabs, folder, galleryPaths, rateLimitSeconds, selectedGallery, maxDate, skipDownloaded) {
  setDownloadStatus(true);
  console.log('[Download] Starting sequential download process.');

  const delaySeconds = Math.max(0, Number(rateLimitSeconds) || 1.5);

  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      // Match on the registered domain, not the bare hostname, so regional
      // hosts (es.pinterest.com) and www. prefixes resolve to the same gallery.
      const domain = typeof findGalleryDomain === 'function'
        ? findGalleryDomain(url.hostname)
        : null;
      const isSelectedGallery = selectedGallery === 'custom'
        ? !domain
        : domain === selectedGallery;
      const galleryPath = (domain && galleryPaths?.[domain]) || { images: folder || 'PIC', videos: folder || 'MOV' };

      console.log(`[Download] Tab ${tab.id}: host=${url.hostname}, domain=${domain}, selectedGallery=${isSelectedGallery}`);

      if (!isSelectedGallery) {
        console.log(`[Download] Skipping tab ${tab.id} (gallery not selected)`);
        continue;
      }

      broadcast('download-progress', logItem(tab, 'queued'));

      try {
        // Programmatically inject the gallery registry and content script to ensure it's available
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['naming.js', 'galleries.js', 'galleries/deviantart.js', 'galleries/pinterest.js', 'content.js'],
        });

        console.log(`[Download] Sending 'find-main-image' to tab ${tab.id}`);
        broadcast('download-progress', logItem(tab, 'scanning'));

        // Send a message to the now-injected content script
        const response = await chrome.tabs.sendMessage(tab.id, {
          command: 'find-main-image',
        });

        if (response && response.status === 'found-images' && response.images?.length) {
          // Date filter: if both the setting and the page date are known, only download
          // tabs whose page date is on or after the maxDate.
          if (maxDate && response.pageDate && response.pageDate < maxDate) {
            console.log(`[Download] Skipping tab ${tab.id}: page date ${response.pageDate} is before maxDate ${maxDate}`);
            broadcast('download-progress', logItem(tab, 'skipped', {
              title: response.title,
              filename: response.images.map((i) => i.filename).join(', '),
              reason: 'before max date'
            }));
          } else if (!response.isMainImageView) {
            console.log(`[Download] Skipping tab ${tab.id}: not a main image view.`);
            broadcast('download-progress', logItem(tab, 'skipped', {
              title: response.title,
              reason: 'not main image view'
            }));
          } else {
            await downloadTabImages(tab, response, galleryPath, delaySeconds, skipDownloaded);
          }
        } else if (response && response.status === 'skipped') {
          console.log(`[Download] Skipped tab ${tab.id}: ${response.reason}`);
          broadcast('download-progress', logItem(tab, 'skipped', {
            title: response.title,
            reason: response.reason
          }));
        } else if (response && response.status === 'error') {
          console.error(`[Download] Error in tab ${tab.id}: ${response.message}`);
          broadcast('download-progress', logItem(tab, 'error', {
            title: response.title,
            message: response.message
          }));
        } else {
          console.log(`[Download] No image found in tab ${tab.id}`);
          broadcast('download-progress', logItem(tab, 'skipped', {
            title: response?.title,
            reason: 'no image found'
          }));
        }
      } catch (error) {
        // This error can happen on special browser pages (e.g., about:, chrome://)
        // where content script injection is not allowed.
        console.log(`[Download] Could not inject or communicate with tab ${tab.id}: ${error.message}`);
        broadcast('download-progress', logItem(tab, 'error', {
          message: `Could not scan tab: ${error.message}`
        }));
      }
    } catch (e) {
      console.warn(`[Download] Skipping tab (invalid URL): ${e}`);
    }
  }
  setDownloadStatus(false, Date.now());
  console.log('[Download] All downloads complete.');
  broadcast('download-complete');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Command from the popup to start scanning
  if (message.command === 'scan-all-tabs') {
    console.log('[Download] Received scan-all-tabs command.');
    // Explicitly get all settings from storage, falling back to defaults.
    chrome.storage.local.get(['folder', 'galleryPaths', 'rateLimit', 'gallery', 'maxDate', 'skipDownloaded'], (settings) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting settings:', chrome.runtime.lastError);
        return;
      }
      console.log('[Download] Loaded settings:', settings);
      const folder = settings.folder ?? DEFAULT_SETTINGS.folder;
      const galleryPaths = settings.galleryPaths || DEFAULT_SETTINGS.galleryPaths;
      const rateLimitSeconds = settings.rateLimit ?? DEFAULT_SETTINGS.rateLimit;
      const selectedGallery = settings.gallery || DEFAULT_SETTINGS.gallery;
      const maxDate = settings.maxDate || '';
      const skipDownloaded = settings.skipDownloaded ?? DEFAULT_SETTINGS.skipDownloaded;
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        console.log(`[Download] Found ${tabs.length} tabs in the current window to scan.`);
        downloadImagesSequentially(tabs, folder, galleryPaths, rateLimitSeconds, selectedGallery, maxDate, skipDownloaded);
      });
    });
    return true; // Indicates an async response
  }

});

// Open the sidebar/side panel when the toolbar icon is clicked.
if (typeof browser !== 'undefined' && browser.sidebarAction) {
  browser.action.onClicked.addListener(() => browser.sidebarAction.open());
} else if (typeof chrome !== 'undefined' && chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set side panel behavior:', error));
}
