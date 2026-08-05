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

/*
 * Firefox MV3 background scripts are event pages and Chrome's are service
 * workers: both are unloaded once they look idle, and a run that spends most
 * of its time inside setTimeout looks exactly like that. Losing the page
 * mid-run leaves the sidebar waiting on progress that will never arrive.
 * Touching an extension API on a timer resets that idle countdown, and the
 * heartbeat doubles as proof-of-life for the sidebar's watchdog.
 */
const KEEPALIVE_MS = 20000;
let keepAliveTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch (error) { /* API shape differs; the call itself is what matters */ }
    broadcast('download-heartbeat');
  }, KEEPALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// State for the run in progress, so the sidebar can stop it. The harvest lives
// in a content script, so cancelling means telling that tab to stop too.
const runState = { cancelled: false, harvestTabId: null };

function isCancelled() {
  return runState.cancelled;
}

function cancelRun() {
  if (runState.cancelled) return;
  runState.cancelled = true;
  console.log('[Download] Stop requested.');
  if (runState.harvestTabId != null) {
    try {
      chrome.tabs.sendMessage(runState.harvestTabId, { command: 'cancel-harvest' }).catch(() => {});
    } catch (error) { /* tab gone */ }
  }
}

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

    const downloadId = await withTimeout(chrome.downloads.download({
      url: imageUrl,
      filename: fullFilename,
      conflictAction: 'uniquify',
      saveAs: false
    }), 60000, `starting download of ${filename}`);

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

/* -------------------------------------------------------------------------
   Adaptive rate-limit throttle

   DeviantArt applies adaptive rate limiting with no published ceiling, and
   their docs warn that continuing to request at a fixed rate while limited
   "will take much longer to get back to a state where your requests are not
   limited". So every rate-limit signal does two things: pause the run for a
   growing cooldown, and lengthen the inter-download delay (0.5 -> 1.0 -> 1.5).

   After a long clean streak the delay eases back one step at a time, so a
   single early hit does not slow a 10,000-image gallery for hours. Everything
   returns to the configured value once the gallery finishes.
   ------------------------------------------------------------------------- */

const RATE_LIMIT_STEP = 0.5;      // seconds added to the delay per escalation
const RATE_LIMIT_MAX_LEVEL = 10;  // ceiling, so the delay cannot run away
const RATE_LIMIT_RECOVERY = 50;   // clean downloads before easing back a step
const RATE_LIMIT_MAX_COOLDOWN = 300; // seconds; matches the usual CloudFront block
const CLOUDFRONT_BLOCK_COOLDOWN = 120; // seconds; first wait after a 403 block
// Give up rather than grind: DeviantArt warn that requesting at a fixed rate
// while limited "will take much longer to get back" to normal, so once the
// block is clearly sustained the only useful move is to stop and let it lapse.
const RATE_LIMIT_ABORT_STREAK = 5;

// chrome.downloads interrupt reasons that mean the image host pushed back.
// These come from the wixmp CDN rather than deviantart.com itself.
const RATE_LIMIT_DOWNLOAD_ERRORS = new Set(['SERVER_FORBIDDEN', 'SERVER_FAILED']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createThrottle(baseSeconds) {
  const base = Math.max(0, Number(baseSeconds) || 0);
  return { base, delaySeconds: base, level: 0, streak: 0, hits: 0 };
}

/**
 * Escalate one step and report how long to wait before trying again.
 * `minCooldown` raises the floor for heavier signals: a CloudFront 403 block
 * is not a gentle "slow down" like a 429, and is conventionally waited out for
 * minutes rather than seconds.
 */
function throttleHit(throttle, reason, minCooldown = 0) {
  throttle.hits++;
  throttle.streak = 0;
  if (throttle.level < RATE_LIMIT_MAX_LEVEL) throttle.level++;
  throttle.delaySeconds = throttle.base + RATE_LIMIT_STEP * throttle.level;
  const cooldown = Math.min(RATE_LIMIT_MAX_COOLDOWN,
    Math.max(minCooldown, 5 * Math.pow(2, throttle.level - 1)));
  console.warn(`[Download] Rate limited (${reason}). Level ${throttle.level}: `
    + `delay ${throttle.delaySeconds}s, cooling down ${cooldown}s`);
  return cooldown * 1000;
}

function throttleSuccess(throttle) {
  if (throttle.level === 0) return;
  throttle.streak++;
  if (throttle.streak >= RATE_LIMIT_RECOVERY) {
    throttle.streak = 0;
    throttle.level--;
    throttle.delaySeconds = throttle.base + RATE_LIMIT_STEP * throttle.level;
    console.log(`[Download] Recovered a step: delay now ${throttle.delaySeconds}s`);
  }
}

function throttleReset(throttle) {
  if (throttle.level) console.log(`[Download] Throttle reset to ${throttle.base}s`);
  throttle.level = 0;
  throttle.streak = 0;
  throttle.delaySeconds = throttle.base;
}

/**
 * Fetch a deviation page, backing off on the codes DeviantArt uses to push
 * back: 429 (adaptive rate limit) and 403 (CloudFront "Request blocked").
 * Plain network errors get one cheap retry without escalating the throttle.
 */
// A hung connection must never stall the run: the batch is awaited with
// Promise.all, so one socket that never answers would block every other page
// in it indefinitely. fetch() has no built-in timeout, hence the abort.
const FETCH_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { credentials: 'include', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Run a promise with a hard ceiling, so no single step can wedge the queue. */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchDeviationPage(url, throttle, maxAttempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchWithTimeout(url);
      if (response.status === 429 || response.status === 403) {
        if (attempt >= maxAttempts) return { url, error: `HTTP ${response.status} (rate limited)` };
        // 403 here is CloudFront's "Request blocked", which also hits ordinary
        // browsing; back off for minutes, not seconds.
        const floor = response.status === 403 ? CLOUDFRONT_BLOCK_COOLDOWN : 0;
        await sleep(throttleHit(throttle, `HTTP ${response.status}`, floor));
        continue;
      }
      if (!response.ok) return { url, error: `HTTP ${response.status}` };
      const html = await withTimeout(response.text(), FETCH_TIMEOUT_MS, 'reading body');
      throttleSuccess(throttle);
      return { url, html };
    } catch (error) {
      const reason = error.name === 'AbortError' ? `no response in ${FETCH_TIMEOUT_MS / 1000}s` : error.message;
      console.warn(`[Download] Fetch attempt ${attempt}/${maxAttempts} failed for ${url}: ${reason}`);
      if (attempt >= maxAttempts) return { url, error: reason };
      await sleep(1000);
    }
  }
}

/**
 * Watch download interrupts for the duration of a run. The image host answers
 * through chrome.downloads rather than fetch, so its push-back only shows up
 * here. Non-blocking: it feeds the throttle without stalling the queue.
 */
function watchDownloadErrors(throttle) {
  const listener = (delta) => {
    const reason = delta.error?.current;
    if (reason && RATE_LIMIT_DOWNLOAD_ERRORS.has(reason)) {
      throttleHit(throttle, `download ${reason}`);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
  return () => chrome.downloads.onChanged.removeListener(listener);
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
    // Gallery runs only: epoch ms, formatted in the sidebar so the estimate
    // follows the interface language rather than the worker's locale.
    startedAt: extra.startedAt || 0,
    etaAt: extra.etaAt || 0,
    durationMs: extra.durationMs || 0,
    reason: extra.reason || '',
    message: extra.message || '',
    timestamp: Date.now(),
  };
}

/**
 * Projected finish time from the rate achieved so far, or 0 while there is not
 * yet enough evidence. Deviations vary a lot in image count, so a handful of
 * samples first keeps the first estimate from being wildly optimistic.
 */
const ETA_MIN_SAMPLES = 3;

function projectFinish(startedAt, done, total) {
  if (done < ETA_MIN_SAMPLES || done >= total) return 0;
  const elapsed = Date.now() - startedAt;
  if (elapsed <= 0) return 0;
  const perItem = elapsed / done;
  return Date.now() + Math.round(perItem * (total - done));
}

/**
 * Expand one gallery / search index tab into its deviation pages and download
 * each of them without ever opening a tab: the page HTML is fetched directly
 * and the parser reads the embedded state out of the raw text (service workers
 * have no DOMParser, and none is needed).
 *
 * `credentials: 'include'` sends the browser's DeviantArt cookies, so
 * logged-in-only deviations resolve exactly as they do while browsing.
 * Links are processed in batches so a large gallery does not fire hundreds of
 * concurrent requests.
 */
async function downloadIndexTab(tab, links, ctx) {
  const { parser, galleryPath, throttle, skipDownloaded, preferPreview, maxDate, batchSize } = ctx;
  const counts = { downloaded: 0, skipped: 0, error: 0 };
  let thumbUrl = '';
  const startedAt = Date.now();
  let processed = 0;                     // deviations walked, for the progress row
  let blockedStreak = 0;                 // consecutive rate-limited pages
  let abandoned = false;                 // stopped early because we are blocked
  const skippedReasons = new Set();      // e.g. subscription locked, literature
  const size = Math.max(1, Number(batchSize) || DEFAULT_SETTINGS.batchSize);

  for (let start = 0; start < links.length && !isCancelled() && !abandoned;) {
    // Shrink the burst while throttled: concurrent fetches are exactly what an
    // adaptive limiter reacts to, so back-pressure should reduce them first.
    const burst = throttle.level > 0 ? Math.max(1, Math.floor(size / (throttle.level + 1))) : size;
    const batch = links.slice(start, start + burst);
    start += burst;

    const batchNo = Math.floor(start / Math.max(1, burst)) + 1;
    console.log(`[Download] Batch ${batchNo}: fetching ${batch.length} pages `
      + `(${processed}/${links.length} done, delay ${throttle.delaySeconds}s)`);
    const started = Date.now();
    const pages = await Promise.all(batch.map((url) => fetchDeviationPage(url, throttle)));
    console.log(`[Download] Batch ${batchNo}: fetched in ${Math.round((Date.now() - started) / 1000)}s`);

    for (const page of pages) {
      if (isCancelled()) break;
      // Progress counts deviations, matching `total`. The counters below are
      // per image, so a carousel would otherwise push this past the total.
      processed++;
      broadcast('download-progress', logItem(tab, 'downloading', {
        title: tab.title,
        filename: page.url,
        thumbUrl,
        count: processed,
        total: links.length,
        startedAt,
        etaAt: projectFinish(startedAt, processed - 1, links.length),
      }));

      if (page.error) {
        counts.error++;
        console.error(`[Download] Could not fetch ${page.url}: ${page.error}`);
        if (/rate limited|HTTP 403|HTTP 429/.test(page.error)) {
          blockedStreak++;
          if (blockedStreak >= RATE_LIMIT_ABORT_STREAK) {
            abandoned = true;
            console.error('[Download] DeviantArt is blocking requests; stopping this gallery. '
              + 'Wait a few minutes before trying again.');
            break;
          }
        }
        continue;
      }
      blockedStreak = 0;

      const parsed = parser.parseDeviationHtml(page.html, page.url, { preferPreview });
      if (!parsed) {
        counts.error++;
        console.warn(`[Download] Could not parse ${page.url}`);
        continue;
      }
      // Subscription-locked art, literature and journals are skipped quietly:
      // they are expected in any large gallery, not failures.
      if (parsed.unavailable || !parsed.images.length) {
        counts.skipped++;
        skippedReasons.add(parsed.unavailable || 'no downloadable media');
        console.log(`[Download] Skipping ${page.url}: ${parsed.unavailable || 'no downloadable media'}`);
        continue;
      }
      if (maxDate && parsed.pageDate && parsed.pageDate < maxDate) {
        counts.skipped++;
        continue;
      }

      for (const image of parsed.images) {
        if (isCancelled()) break;
        const targetFolder = pickSubfolder(image.filename, galleryPath);
        const result = await downloadImage(image.imageUrl, image.filename, targetFolder, skipDownloaded);
        if (result.status === 'success') {
          counts.downloaded++;
          throttleSuccess(throttle);
          if (!thumbUrl) thumbUrl = image.imageUrl;
          await delay(throttle.delaySeconds, throttle.delaySeconds);
        } else if (result.status === 'skipped') {
          counts.skipped++;
        } else {
          counts.error++;
        }
      }
    }
  }

  const status = abandoned ? 'error'
    : counts.downloaded ? 'downloaded' : (counts.skipped ? 'skipped' : 'error');
  const throttled = throttle.hits ? ` (rate limited ${throttle.hits}x)` : '';
  const stopped = abandoned ? ` — BLOCKED after ${processed}/${links.length}, retry later` : '';
  const why = skippedReasons.size ? `, skipped: ${Array.from(skippedReasons).join(', ')}` : '';
  broadcast('download-progress', logItem(tab, status, {
    title: tab.title,
    filename: `${links.length} deviations, ${counts.downloaded} images${why}${throttled}${stopped}`,
    thumbUrl,
    count: counts[status],
    startedAt,
    durationMs: Date.now() - startedAt,
  }));
  // Back to the configured delay for whatever comes next.
  throttleReset(throttle);
}

/**
 * Download every image found in one tab and report a single aggregated log
 * row for that tab. A tab counts as downloaded when at least one of its
 * images landed, so a partly-duplicate tab still reads as a success.
 */
async function downloadTabImages(tab, response, galleryPath, throttle, skipDownloaded) {
  const images = response.images;
  const allNames = images.map((image) => image.filename).join(', ');
  const counts = { downloaded: 0, skipped: 0, error: 0 };
  let thumbUrl = '';
  let lastReason = '';
  let lastMessage = '';

  for (let i = 0; i < images.length; i++) {
    if (isCancelled()) break;
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
      throttleSuccess(throttle);
      if (!thumbUrl) thumbUrl = image.imageUrl;
      await delay(throttle.delaySeconds, throttle.delaySeconds);
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
async function downloadImagesSequentially(tabs, folder, galleryPaths, rateLimitSeconds, selectedGallery, maxDate, skipDownloaded, preferPreview, expandGalleries, galleryPaginate, batchSize) {
  setDownloadStatus(true);
  console.log('[Download] Starting sequential download process.');

  runState.cancelled = false;
  runState.harvestTabId = null;
  startKeepAlive();
  const registry = (typeof self !== 'undefined' && self.GALLERY_PARSERS) || {};
  const throttle = createThrottle(
    Number.isFinite(Number(rateLimitSeconds)) ? Number(rateLimitSeconds) : DEFAULT_SETTINGS.rateLimit);
  const stopWatchingDownloads = watchDownloadErrors(throttle);

  for (const tab of tabs) {
    if (isCancelled()) break;
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

        broadcast('download-progress', logItem(tab, 'scanning'));

        // A gallery / search index page is expanded into its deviations;
        // anything else is scanned for its own main image.
        const parser = registry[domain];
        const isIndex = expandGalleries && parser
          && typeof parser.isIndexView === 'function'
          && parser.isIndexView(url.hostname, url.pathname)
          && typeof parser.parseDeviationHtml === 'function';

        console.log(`[Download] Sending '${isIndex ? 'find-index-links' : 'find-main-image'}' to tab ${tab.id}`);
        if (isIndex) runState.harvestTabId = tab.id;
        const response = isIndex
          ? await chrome.tabs.sendMessage(tab.id, {
              command: 'find-index-links',
              options: { paginate: galleryPaginate },
            })
          : await chrome.tabs.sendMessage(tab.id, {
              command: 'find-main-image',
              options: { preferPreview },
            });

        if (response && response.status === 'found-links') {
          if (!response.links.length) {
            console.log(`[Download] Gallery tab ${tab.id}: no deviation links found.`);
            broadcast('download-progress', logItem(tab, 'skipped', {
              title: response.title, reason: 'no gallery links',
            }));
          } else {
            console.log(`[Download] Gallery tab ${tab.id}: expanding ${response.links.length} deviations.`);
            await downloadIndexTab(tab, response.links, {
              parser: registry[domain], galleryPath, throttle,
              skipDownloaded, preferPreview, maxDate, batchSize,
            });
          }
        } else if (response && response.status === 'found-images' && response.images?.length) {
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
            await downloadTabImages(tab, response, galleryPath, throttle, skipDownloaded);
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
  stopWatchingDownloads();
  stopKeepAlive();
  setDownloadStatus(false, Date.now());
  console.log(runState.cancelled ? '[Download] Stopped by user.' : '[Download] All downloads complete.');
  broadcast('download-complete');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'stop-scan') {
    cancelRun();
    sendResponse({ status: 'stopping' });
    return false;
  }

  // Live link count while a gallery page is being walked. sender.tab gives the
  // row to update, which the content script itself cannot know.
  if (message.command === 'harvest-progress') {
    if (sender.tab) {
      broadcast('download-progress', logItem(sender.tab, 'scanning', {
        count: message.count, total: message.total || 0,
      }));
    }
    return false;
  }

  // Command from the popup to start scanning
  if (message.command === 'scan-all-tabs') {
    console.log('[Download] Received scan-all-tabs command.');
    // Answer straight away. Returning true without ever calling sendResponse
    // leaves the channel dangling, which Firefox reports as "Promised response
    // from onMessage listener went out of scope" once it is collected.
    sendResponse({ status: 'started' });
    // Explicitly get all settings from storage, falling back to defaults.
    chrome.storage.local.get(['folder', 'galleryPaths', 'rateLimit', 'gallery', 'maxDate', 'skipDownloaded', 'preferPreview', 'expandGalleries', 'galleryPaginate', 'batchSize'], (settings) => {
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
      const preferPreview = settings.preferPreview ?? DEFAULT_SETTINGS.preferPreview;
      const expandGalleries = settings.expandGalleries ?? DEFAULT_SETTINGS.expandGalleries;
      const galleryPaginate = settings.galleryPaginate ?? DEFAULT_SETTINGS.galleryPaginate;
      const batchSize = settings.batchSize ?? DEFAULT_SETTINGS.batchSize;
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        console.log(`[Download] Found ${tabs.length} tabs in the current window to scan.`);
        downloadImagesSequentially(tabs, folder, galleryPaths, rateLimitSeconds, selectedGallery, maxDate, skipDownloaded, preferPreview, expandGalleries, galleryPaginate, batchSize);
      });
    });
    return false; // Already answered synchronously above.
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
