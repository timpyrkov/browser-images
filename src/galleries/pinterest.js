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
// The displayed image is read from the DOM instead, which is correct for both
// full page loads and in-app navigation. og:image is kept only as a last resort.
//
// Animation / video pins are detected by looking for a <video> element in the
// closeup. Multi-image pins use a conservative carousel fallback.
(function (global) {
  'use strict';

  const helpers = (global && global.GALLERY_HELPERS) || {};

  // Pinterest's own hooks around the closeup image, best first.
  const CLOSEUP_SELECTORS = [
    '[data-test-id="pin-closeup-image"]',
    '[data-test-id="closeup-image"]',
    '[data-test-id="visual-search-pin-image"]',
  ];

  const PINIMG_HOST = /(^|\.)pinimg\.com$/i;

  function resolve(url) {
    return helpers.resolveImageUrl ? helpers.resolveImageUrl(url) : url || null;
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

  function isPinImage(url) {
    try {
      return PINIMG_HOST.test(new URL(url).hostname);
    } catch (error) {
      return false;
    }
  }

  /** Largest rendered pinimg image on the page. Used when the test-id hooks
   *  change: the closeup is always the biggest image in a pin view, well clear
   *  of the 236x/474x thumbnails in the "more like this" grid below it. */
  function largestPinImage(doc) {
    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        return src && isPinImage(src) && img.naturalWidth > 300 && img.naturalHeight > 150;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return images.length ? resolve(images[0].currentSrc || images[0].src) : null;
  }

  /** True if this is a /pin/{id} detail page. Accepts either a pathname or a
   *  full URL. */
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
      isIndexView(hostname, pathname) {
        // Board / profile / search harvesting is disabled for now. Pinterest
        // pages are rendered by JS, so collecting pin links and fetching each
        // one from the background script yields empty app-shell HTML and
        // fails every download. Supporting boards properly requires extracting
        // grid images directly in the content script, which is a larger change.
        return false;
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      extractImageUrls(doc, href) {
        if (!isPinPage(href || (doc.location && doc.location.pathname))) return [];
        const title = doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : '';

        // Animation / video pins expose a <video> element. Prefer the video URL.
        const videos = Array.from(doc.querySelectorAll ? doc.querySelectorAll('video') : [])
          .map((v) => v.currentSrc || v.src)
          .filter(Boolean);
        if (videos.length) {
          return videos.map((url) => ({ imageUrl: url, kind: 'video', title }));
        }

        // Pinterest's own closeup hooks are the most reliable path for
        // single-image pins.
        for (const selector of CLOSEUP_SELECTORS) {
          const url = resolve(imageIn(doc.querySelector(selector)));
          if (url) return [{ imageUrl: url, kind: 'image', title }];
        }

        // Conservative multi-image / carousel fallback: only collect additional
        // large closeup-sized images if the first hook did not match. This
        // avoids picking up "more like this" thumbnails.
        const closeupContainer = doc.querySelector('[data-test-id="pin-closeup"]')
          || doc.querySelector('[data-test-id="closeup"]');
        if (closeupContainer) {
          const seen = new Set();
          const urls = [];
          const containerImages = Array.from(closeupContainer.querySelectorAll('img'))
            .filter((img) => {
              const src = img.currentSrc || img.src;
              return src && isPinImage(src) && img.naturalWidth >= 300 && img.naturalHeight >= 150;
            })
            .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
          for (const img of containerImages) {
            const src = resolve(img.currentSrc || img.src);
            if (!seen.has(src)) {
              seen.add(src);
              urls.push(src);
            }
          }
          if (urls.length) {
            return urls.map((url) => ({ imageUrl: url, kind: 'image', title }));
          }
        }

        const largest = largestPinImage(doc);
        if (largest) return [{ imageUrl: largest, kind: 'image', title }];

        // Last resort only: goes stale after in-app navigation.
        const og = doc.querySelector("meta[property='og:image']");
        const fallback = resolve(og && og.getAttribute('content'));
        return fallback ? [{ imageUrl: fallback, kind: 'image', title }] : [];
      },
    };
  }

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createPinterestParser());
  } else {
    global.createPinterestParser = createPinterestParser;
  }
})(typeof self !== 'undefined' ? self : this);
