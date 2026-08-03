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

function getLargestVisibleImage() {
  const images = Array.from(document.images)
    .filter((img) => img.complete && img.naturalWidth > 300 && img.naturalHeight > 150)
    .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
  return resolveImageUrl(images[0]?.currentSrc || images[0]?.src);
}

// Gallery detection and image extraction logic
async function getMainImageUrls(options = {}) {
  const hostname = location.hostname;
  const urls = [];

  // 1. Site-specific parser from the registry
  const parser = findParser(hostname);
  if (parser && typeof parser.extractImageUrls === 'function') {
    const parsed = await parser.extractImageUrls(document, location.href, options);
    if (parsed && parsed.length) urls.push(...parsed);
  } else if (parser && typeof parser.extractImageUrl === 'function') {
    const single = parser.extractImageUrl(document);
    if (single) urls.push(single);
  }

  if (urls.length) return urls;

  // 2. Open Graph fallback
  const ogImage = resolveImageUrl(document.querySelector("meta[property='og:image']")?.content);
  if (ogImage) return [ogImage];

  // 3. Largest visible image fallback
  const largest = getLargestVisibleImage();
  if (largest) return [largest];

  return [];
}

// Helper: Determine if this is a main image view (not a gallery) based on URL structure
function isMainImageViewUrl(hostname, pathname) {
  const parser = findParser(hostname);
  if (!parser) return true; // Unknown domains are allowed; the gallery selector handles them.
  return parser.isMainImageView(hostname, pathname);
}

// Allowed image/media extensions we preserve when present in the URL.
// `var` (not const): background.js re-injects this file on every scan, and a
// top-level const would throw on redeclaration in the same isolated world.
var VALID_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'gif', 'png', 'avif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'ico', 'heic', 'heif', 'jfif', 'pjpeg', 'pjp', 'mp4', 'webm', 'mov', 'mkv'
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

    // Strip characters that are illegal in common filesystems.
    name = name.replace(/[<>:"|?*\x00-\x1f]/g, '');
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
  if (path.includes('.svg')) return 'svg';
  if (path.includes('.avif')) return 'avif';
  if (path.includes('.webm')) return 'webm';
  if (path.includes('.mp4')) return 'mp4';
  return 'jpg';
}

// Listen for a message from the background script to start scanning.
// Guarded so repeated injections don't register duplicate listeners
// (each would call sendResponse for the same request).
if (!self.__BI_CONTENT_LISTENER__) {
  self.__BI_CONTENT_LISTENER__ = true;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
          sendResponse({ status: 'not-found' });
          return;
        }
        const hostname = location.hostname;
        const pathname = location.pathname;
        const isMainImageView = isMainImageViewUrl(hostname, pathname);
        const title = document.title?.trim() || location.hostname;
        const parser = findParser(hostname);
        const pageDate = parser ? parser.extractPageDate(document) : null;
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
