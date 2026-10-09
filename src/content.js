// content.js
// Script injected into every tab to detect if it is an image gallery and find the main image
// Communicates with background.js to send image info
// Beginner-friendly documentation included

// Per-gallery parsers are loaded from galleries.js before this script runs.
// GALLERY_PARSERS maps a domain substring to a parser object with
// isMainImageView(), extractImageUrl(), and extractPageDate().
function findParser(hostname) {
  const registry = (typeof self !== 'undefined' && self.GALLERY_PARSERS) || {};
  const key = typeof self.findGalleryDomain === 'function'
    ? self.findGalleryDomain(hostname)
    // Same rule as galleries.js: exact host or a subdomain of it.
    : Object.keys(registry).find((d) => hostname === d || hostname.endsWith(`.${d}`));
  return key ? registry[key] : null;
}

/*
 * Chromium-only page-context bridges (Chrome, Opera, Yandex). Firefox keeps
 * its own paths - content.fetch for ArtStation, the inline-script bridge for
 * DeviantArt - so these are not defined there at all.
 *
 * - Chromium content-script fetches do not carry the page's same-origin
 *   context, so ArtStation's Cloudflare rejects /projects/*.json. The
 *   background runs the request in the tab's MAIN world (same origin only).
 * - DeviantArt's CSP blocks the inline-script bridge in Opera, so its state
 *   global is read from the MAIN world instead.
 *
 * Neither may ever throw into a parser: a background that does not answer
 * (e.g. an older background still running after the files were updated)
 * must degrade to the next fallback, never turn the tab into an error.
 */
if (typeof browser === 'undefined') {
  self.__BI_PAGE_FETCH__ = async function pageContextFetch(url) {
    let reply = null;
    try {
      reply = await chrome.runtime.sendMessage({ command: 'page-fetch', url });
    } catch (error) { /* no answer from the background: use a direct fetch */ }
    // A rejection (e.g. a cross-origin URL) is final; only a background that
    // did not answer at all falls back, and then still only to this origin.
    if (reply && reply.error) throw new Error(reply.error);
    if (!reply) {
      const target = new URL(url, location.href);
      if (target.protocol !== 'https:' || target.origin !== location.origin) throw new Error('Cross-origin page fetch rejected');
      return fetch(target.href, { credentials: 'include' });
    }
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => JSON.parse(reply.body),
      text: async () => reply.body,
    };
  };

  self.__BI_PAGE_STATE__ = async function pageContextState() {
    try {
      const reply = await chrome.runtime.sendMessage({ command: 'page-state' });
      return reply && !reply.error ? reply.state : null;
    } catch (error) {
      return null;
    }
  };
}

function resolveImageUrl(rawUrl) {
  if (!rawUrl) return null;
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
    console.warn('[Content] Skipping non-HTTP image URL:', trimmed.slice(0, 80));
    return null;
  }
  try {
    const url = new URL(trimmed, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Strip common tracking/query params that break filenames without changing the host image.
    url.searchParams.delete('w');
    url.searchParams.delete('h');
    url.searchParams.delete('q');
    url.searchParams.delete('fm');
    url.searchParams.delete('fit');
    url.searchParams.delete('auto');
    return url.href;
  } catch (error) {
    console.warn('[Content] Could not resolve image URL:', trimmed);
    return null;
  }
}

function queryImageUrl(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  if (el.tagName === 'IMG') return el.currentSrc || el.src;
  return el.getAttribute('content');
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date) ? null : date.toISOString().split('T')[0];
}

// Media URLs come only from the gallery's own parser. There is deliberately no
// generic fallback (og:image, largest image on the page): those can point
// anywhere, and every supported gallery has a parser that knows its media.
async function getMainImageUrls(options = {}) {
  const parser = findParser(location.hostname);
  if (!parser || typeof parser.extractImageUrls !== 'function') return [];
  const parsed = await parser.extractImageUrls(document, location.href, options);
  return parsed && parsed.length ? parsed : [];
}

// Helper: Determine if this is a main image view (not a gallery) based on URL structure
function isMainImageViewUrl(hostname, pathname) {
  const parser = findParser(hostname);
  return !!parser && parser.isMainImageView(hostname, pathname);
}

// Allowed image/media extensions we preserve when present in the URL. No SVG
// or ICO: SVG can carry script, and neither is gallery artwork.
// `var` (not const): background.js re-injects this file on every scan, and a
// top-level const would throw on redeclaration in the same isolated world.
var VALID_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'gif', 'png', 'avif', 'webp', 'tif', 'tiff', 'bmp', 'heic', 'heif', 'jfif', 'pjpeg', 'pjp', 'mp4', 'webm', 'mov', 'mkv'
]);

function normalizeExtension(ext) {
  const lower = ext.toLowerCase();
  if (lower === 'jpeg') return 'jpg';
  if (lower === 'pjpeg' || lower === 'pjp') return 'jpg';
  if (lower === 'tif') return 'tiff';
  if (lower === 'mov' || lower === 'mkv' || lower === 'webm') return lower; // keep video ext if we ever support videos
  return lower;
}

// Helper: Extract a clean, informative filename from the image URL
function extractImageFilename(imageUrl) {
  try {
    const url = new URL(imageUrl);
    let name = decodeURIComponent(url.pathname.split('/').pop());
    if (!name) {
      name = 'image';
    }

    // Remove query string artifacts and whitespace from filenames.
    name = name.split('?')[0].split('#')[0];
    name = name.replace(/\s+/g, '_');

    // Ensure a sensible extension.
    const lastDot = name.lastIndexOf('.');
    const ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : '';
    if (!ext || !VALID_EXTENSIONS.has(normalizeExtension(ext))) {
      // Try to infer extension from Content-Type via URL hints; otherwise default to jpg.
      const inferred = inferExtensionFromUrl(url);
      name = name.replace(/\.+$/, '') + '.' + inferred;
    } else {
      // Normalize jpg spelling.
      const base = name.slice(0, lastDot);
      const normalized = normalizeExtension(ext);
      name = `${base}.${normalized}`;
    }

    // Strip path separators (a decoded %2F) and characters that are illegal
    // in common filesystems, and never start with a dot.
    name = name.replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/^[._]+/, '');
    if (!name) {
      name = `image_${Date.now()}.jpg`;
    }
    return name;
  } catch (error) {
    return `image_${Date.now()}.jpg`;
  }
}

function inferExtensionFromUrl(url) {
  const path = url.pathname.toLowerCase();
  if (path.includes('.png')) return 'png';
  if (path.includes('.gif')) return 'gif';
  if (path.includes('.webp')) return 'webp';
  if (path.includes('.avif')) return 'avif';
  if (path.includes('.webm')) return 'webm';
  if (path.includes('.mp4')) return 'mp4';
  return 'jpg';
}

// Collect the deviation links on a gallery / search index page, optionally
// driving the page's own pagination control.
async function getIndexLinks(options = {}) {
  const parser = findParser(location.hostname);
  if (!parser || typeof parser.extractIndexLinks !== 'function') return [];
  self.__BI_HARVEST_CANCELLED__ = false;
  try {
    return await parser.extractIndexLinks(document, location.href, {
      ...options,
      // Relayed to the sidebar so a multi-minute walk shows a live count
      // instead of looking hung.
      onProgress: (count, total) => {
        try {
          chrome.runtime.sendMessage({
            command: 'harvest-progress', count, total, searchQuery: options.searchQuery || null,
          });
        } catch (e) {}
      },
      shouldStop: () => self.__BI_HARVEST_CANCELLED__ === true,
    });
  } catch (error) {
    console.warn('[Content] Index link collection failed:', error);
    return [];
  }
}

function getIndexSortOrder() {
  const parser = findParser(location.hostname);
  if (!parser || typeof parser.indexSortOrder !== 'function') return null;
  try {
    return parser.indexSortOrder(document, location.href);
  } catch (error) {
    return null;
  }
}

function getIndexSearchTerm() {
  const parser = findParser(location.hostname);
  if (!parser || typeof parser.indexSearchTerm !== 'function') return null;
  try {
    return parser.indexSearchTerm(document, location.href);
  } catch (error) {
    return null;
  }
}

/** Items the gallery's parser found on this page but cannot download. */
function unavailableCount() {
  const parser = findParser(location.hostname);
  try {
    return parser && typeof parser.unavailableCount === 'function' ? Number(parser.unavailableCount()) || 0 : 0;
  } catch (error) {
    return 0;
  }
}

function isIndexViewUrl(hostname, pathname) {
  const parser = findParser(hostname);
  return !!(parser && typeof parser.isIndexView === 'function' && parser.isIndexView(hostname, pathname));
}

// Listen for a message from the background script to start scanning.
// Guarded so repeated injections don't register duplicate listeners
// (each would call sendResponse for the same request).
if (!self.__BI_CONTENT_LISTENER__) {
  self.__BI_CONTENT_LISTENER__ = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Commands come only from this extension's background.
  if (!request || sender?.id !== chrome.runtime.id || sender.tab) return false;
  if (request.command === 'cancel-harvest') {
    self.__BI_HARVEST_CANCELLED__ = true;
    sendResponse({ status: 'cancelling' });
    return false;
  }

  if (request.command === 'find-index-links') {
    (async () => {
      try {
        const searchQuery = getIndexSearchTerm();
        const result = await getIndexLinks({ ...(request.options || {}), searchQuery });
        // Some parsers (e.g. Pinterest boards) return grid images directly
        // instead of links to fetch from the background.
        // No tab-level date: a gallery spans many dates, and the parser has
        // already applied the cutoff per item.
        const unavailable = (result && Number(result.unavailable)) || 0;
        if (result && result.images && (result.images.length || unavailable)) {
          const title = document.title?.trim() || location.hostname;
          if (!result.images.length) {
            // Only undownloadable items (e.g. an all-YouTube portfolio).
            sendResponse({ status: 'partial', count: 0, total: unavailable, title });
            return;
          }
          sendResponse({
            status: 'found-images',
            images: result.images.map((item) => ({
              imageUrl: item.imageUrl,
              filename: item.filename || extractImageFilename(item.imageUrl),
              title: item.title || title,
            })),
            isMainImageView: true,
            title,
            url: location.href,
            pageDate: null,
            unavailable,
          });
          return;
        }
        sendResponse({
          status: 'found-links',
          links: Array.isArray(result) ? result : [],
          searchQuery,
          sortOrder: getIndexSortOrder(),
          isIndexView: isIndexViewUrl(location.hostname, location.pathname),
          title: document.title?.trim() || location.hostname,
          url: location.href,
        });
      } catch (error) {
        sendResponse({ status: 'error', message: error.message });
      }
    })();
    return true;
  }

  if (request.command === 'find-main-image') {
    (async () => {
      try {
        // Parsers may return plain URL strings or {imageUrl, filename, title}
        // objects; normalize to objects before filtering.
        const found = (await getMainImageUrls(request.options || {}))
          .map((item) => (typeof item === 'string' ? { imageUrl: item } : item))
          .filter((item) => item && typeof item.imageUrl === 'string' && item.imageUrl);
        const downloadable = found.filter((item) => !item.imageUrl.startsWith('data:'));
        if (!downloadable.length) {
          if (found.length) {
            console.warn('[Content] Skipping data: URLs (not downloadable):', found);
            sendResponse({ status: 'skipped', reason: 'data-url' });
            return;
          }
          // Everything found is undownloadable (e.g. an ArtStation project that
          // is only a YouTube embed): report "Partial (0/n)", not "no image".
          const unavailable = unavailableCount();
          sendResponse(unavailable
            ? { status: 'partial', count: 0, total: unavailable, title: document.title?.trim() || location.hostname }
            : { status: 'not-found' });
          return;
        }
        const hostname = location.hostname;
        const pathname = location.pathname;
        const isMainImageView = isMainImageViewUrl(hostname, pathname);
        const title = document.title?.trim() || location.hostname;
        const parser = findParser(hostname);
        // A parser that read the date from its own data reports it per item.
        const pageDate = downloadable.find((item) => item.pageDate)?.pageDate
          || (parser ? parser.extractPageDate(document) : null);
        const images = downloadable.map((item) => ({
          imageUrl: item.imageUrl,
          filename: item.filename || extractImageFilename(item.imageUrl),
          title: item.title || title,
        }));
        console.log('[Content] Images detected:', images.length, 'isMainImageView:', isMainImageView, 'pageDate:', pageDate);
        sendResponse({
          status: 'found-images',
          images,
          isMainImageView,
          title: images[0]?.title || title,
          url: location.href,
          pageDate,
          unavailable: unavailableCount(),
        });
      } catch (error) {
        console.error('[Content] Error finding main image:', error);
        sendResponse({ status: 'error', message: error.message });
      }
    })();
    return true; // Keep the message channel open for the async response.
  }
  });
}
