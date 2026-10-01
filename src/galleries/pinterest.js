// galleries/pinterest.js
// Pinterest-specific parser for the Browser Images extension.
//
// Pinterest is a single-page app: clicking a pin swaps the closeup in place and
// pushes a new URL, but does NOT rewrite the <head>. og:image therefore keeps
// whatever the tab loaded first, so every pin reached by clicking reports the
// same stale image. Verified live: after an in-app hop from pin 7835560351...
// to 9240824173..., location.href updated and the closeup <img> followed, while
// og:image still pointed at the previous pin.
//
// Strategy: use the <meta property="og:image"> URL first — it is the canonical
// closeup image URL that Pinterest exposes to crawlers and it downloads
// reliably. If the user navigated in-app and og:image is stale, fall back to
// the live DOM closeup hook. Board/profile pages are not harvested because
// Pinterest serves JS-rendered app-shell HTML on background fetches.
(function (global) {
  'use strict';

  const helpers = (global && global.GALLERY_HELPERS) || {};

  const CLOSEUP_SELECTORS = [
    '[data-test-id="pin-closeup-image"]',
    '[data-test-id="closeup-image"]',
    '[data-test-id="visual-search-pin-image"]',
  ];

  const PINIMG_HOST = /(^|\.)pinimg\.com$/i;
  const PINTEREST_VIDEO_HOST = /(^|\.)pinterest\.com$/i;

  function resolve(url) {
    return helpers.resolveImageUrl ? helpers.resolveImageUrl(url) : url || null;
  }

  function isPinMediaUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return PINIMG_HOST.test(host) || PINTEREST_VIDEO_HOST.test(host);
    } catch (error) {
      return false;
    }
  }

  /** The <img> for a hook element, which is usually a wrapping <div>. */
  function imageIn(el) {
    if (!el) return null;
    if (el.tagName === 'IMG') return el.currentSrc || el.src || null;
    if (typeof el.querySelector !== 'function') return null;
    const img = el.querySelector('img');
    if (!img) return null;
    return img.currentSrc || img.src || null;
  }

  /** Largest rendered pinimg image on the page. */
  function largestPinImage(doc) {
    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        return src && isPinMediaUrl(src) && img.naturalWidth > 300 && img.naturalHeight > 150;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return images.length ? resolve(images[0].currentSrc || images[0].src) : null;
  }

  /** Closeup <video> source, if any. Only accepts Pinterest-hosted media. */
  function closeupVideoUrl(doc) {
    const container = doc.querySelector('[data-test-id="pin-closeup"]')
      || doc.querySelector('[data-test-id="closeup"]');
    const videos = Array.from(doc.querySelectorAll ? doc.querySelectorAll('video') : [])
      .filter((v) => !container || container.contains(v));
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (src && isPinMediaUrl(src)) return src;
      for (const source of video.querySelectorAll ? video.querySelectorAll('source') : []) {
        const ssrc = source.src || source.getAttribute('src');
        if (ssrc && isPinMediaUrl(ssrc)) return ssrc;
      }
    }
    return null;
  }

  /** True if this is a /pin/{id} detail page. Accepts a pathname or full URL. */
  function isPinPage(href) {
    return /\/pin\/\d+/.test(href || '');
  }

  function createPinterestParser() {
    return {
      domain: 'pinterest.com',
      label: 'Pinterest',
      isMainImageView(hostname, pathname) {
        return /(^|\.)pinterest\./i.test(hostname || '') && isPinPage(pathname);
      },
      isIndexView() {
        // Board / profile / search harvesting is disabled. Pinterest pages are
        // rendered by JS, so collecting pin links and fetching each one from
        // the background script yields empty app-shell HTML and fails every
        // download. Supporting boards properly requires extracting grid images
        // directly in the content script, which is a larger change.
        return false;
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      extractImageUrls(doc, href) {
        if (!isPinPage(href || (doc.location && doc.location.pathname))) return [];
        const title = doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : '';

        // 1. Canonical og:image. This is the most reliable source for a full
        // page load and downloads successfully with the browser's downloader.
        const og = doc.querySelector("meta[property='og:image']");
        const ogUrl = resolve(og && og.getAttribute('content'));
        if (ogUrl && isPinMediaUrl(ogUrl)) {
          return [{ imageUrl: ogUrl, kind: 'image', title }];
        }

        // 2. Pinterest's live closeup hook. Used when og:image is missing (e.g.
        // in-app navigation where the <head> was not rewritten).
        for (const selector of CLOSEUP_SELECTORS) {
          const url = resolve(imageIn(doc.querySelector(selector)));
          if (url && isPinMediaUrl(url)) return [{ imageUrl: url, kind: 'image', title }];
        }

        // 3. Largest visible pinimg image.
        const largest = largestPinImage(doc);
        if (largest) return [{ imageUrl: largest, kind: 'image', title }];

        // 4. Animated / video pins served from Pinterest's CDN.
        const video = closeupVideoUrl(doc);
        if (video) return [{ imageUrl: video, kind: 'video', title }];

        return [];
      },
    };
  }

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createPinterestParser());
  } else {
    global.createPinterestParser = createPinterestParser;
  }
})(typeof self !== 'undefined' ? self : this);
