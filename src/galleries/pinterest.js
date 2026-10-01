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
// Strategy:
// 1. Video / animated pins: Pinterest embeds MP4 URLs (usually on v1.pinimg.com)
//    in the page HTML. Find them, pick the best quality/expMp4 variant, and
//    return the video URL.
// 2. Static pins: use <meta property="og:image">, which is the canonical closeup
//    image URL Pinterest exposes to crawlers and which downloads reliably.
// 3. If the user navigated in-app and og:image is stale, fall back to the live
//    DOM closeup hook / largest visible pinimg image.
// Board/profile pages are not harvested because Pinterest serves JS-rendered
// app-shell HTML on background fetches.
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

  /** True for URLs that look like an actual pin image, not site assets or
   *  generic social-sharing images (e.g. facebook_share_image.png). Pinterest
   *  pin images use a 32-character hex filename, while site icons and share
   *  cards use descriptive names. */
  function looksLikePinImage(url) {
    if (!isPinMediaUrl(url)) return false;
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split('/').pop() || '';
      const name = filename.replace(/\.[a-z0-9]+$/i, '');
      // Allow 32-char hex Pinterest hashes; reject descriptive generic names.
      if (/^[a-f0-9]{32}$/i.test(name)) return true;
      return false;
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

  /** Largest rendered actual pin image on the page. */
  function largestPinImage(doc) {
    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        return src && looksLikePinImage(src) && img.naturalWidth > 300 && img.naturalHeight > 150;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return images.length ? resolve(images[0].currentSrc || images[0].src) : null;
  }

  /** Scan the document HTML for all i.pinimg.com URLs that look like real pin
   *  images, then return the largest /originals/ size available. */
  function pinImageUrlsFromHtml(doc) {
    const html = (doc.documentElement && (doc.documentElement.outerHTML || doc.documentElement.innerHTML)) || '';
    const urls = [];
    const seen = new Set();
    const regex = /https?:\/\/i\.pinimg\.com\/[^"'\s<>]+\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{26,}\.[a-z0-9]+/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = match[0];
      if (looksLikePinImage(url) && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  }

  /** Pick the largest available size of a pin image by replacing the size
   *  folder with /originals/ when present. */
  function bestPinImageUrl(urls) {
    if (!urls.length) return null;
    const originals = urls.filter((u) => u.includes('/originals/'));
    if (originals.length) return originals[0];
    const sized = urls.filter((u) => /\/\d{2,4}x\d{2,4}\//.test(u));
    if (sized.length) {
      const sorted = sized.slice().sort((a, b) => {
        const ma = a.match(/\/(\d+)x(\d+)\//);
        const mb = b.match(/\/(\d+)x(\d+)\//);
        return (mb ? mb[1] * mb[2] : 0) - (ma ? ma[1] * ma[2] : 0);
      });
      return sorted[0];
    }
    return urls[0];
  }

  /** All closeup <video> sources, only Pinterest-hosted. */
  function closeupVideoUrls(doc) {
    const urls = [];
    const seen = new Set();
    const container = doc.querySelector('[data-test-id="pin-closeup"]')
      || doc.querySelector('[data-test-id="closeup"]');
    const videos = Array.from(doc.querySelectorAll ? doc.querySelectorAll('video') : [])
      .filter((v) => !container || container.contains(v));
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (src && isPinMediaUrl(src) && !seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
      for (const source of video.querySelectorAll ? video.querySelectorAll('source') : []) {
        const ssrc = source.src || source.getAttribute('src');
        if (ssrc && isPinMediaUrl(ssrc) && !seen.has(ssrc)) {
          seen.add(ssrc);
          urls.push(ssrc);
        }
      }
    }
    return urls;
  }

  /** Pinterest video URLs appear in the page HTML even in the app-shell state. */
  function videoUrlsFromHtml(doc) {
    const html = (doc.documentElement && (doc.documentElement.outerHTML || doc.documentElement.innerHTML)) || '';
    const urls = [];
    const seen = new Set();
    const regex = /https?:\/\/[^"'\s<>]+\.pinimg\.com\/videos\/[^"'\s<>]+\.mp4/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = match[0];
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  }

  /** Extract the stable video hash from a Pinterest MP4 URL. Different
   *  codec/size variants of the same video share the same hash (the filename
   *  stem before _{width}w.mp4). */
  function videoHashFromUrl(url) {
    try {
      const filename = new URL(url).pathname.split('/').pop() || '';
      return filename.replace(/_\d+w\.mp4(?:[?#].*)?$/, '');
    } catch (error) {
      return url.replace(/_\d+w\.mp4(?:[?#].*)?$/, '');
    }
  }

  /** Given a list of MP4 variants, group by video hash and keep the best
   *  quality (expMp4 > hevc, highest width) for each distinct video. */
  function uniqueBestVideoUrls(urls) {
    if (!urls.length) return [];
    const groups = {};
    for (const url of urls) {
      const hash = videoHashFromUrl(url);
      let score = 0;
      if (url.includes('/expMp4/')) score += 10000;
      const resMatch = url.match(/_(\d+)w\.mp4/);
      if (resMatch) score += parseInt(resMatch[1], 10);
      if (!groups[hash] || groups[hash].score < score) {
        groups[hash] = { url, score };
      }
    }
    return Object.values(groups).map((g) => g.url);
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

        // 1. Video / animated pins. Pinterest embeds MP4 URLs in the HTML even in
        // the app-shell state. Group variants by base video ID and return the
        // best quality for each distinct video.
        const domVideos = closeupVideoUrls(doc);
        const htmlVideos = videoUrlsFromHtml(doc);
        const allVideos = [...new Set([...domVideos, ...htmlVideos])];
        const bestVideos = uniqueBestVideoUrls(allVideos);
        if (bestVideos.length) {
          return bestVideos.map((url) => ({ imageUrl: url, kind: 'video', title }));
        }

        // 2. Static pin images. Validate og:image: sometimes it is a generic
        // social-sharing image (facebook_share_image.png) rather than the
        // actual pin. If it does not look like a real pin image, fall back to
        // scanning the page HTML for the actual pin image hash.
        const og = doc.querySelector("meta[property='og:image']");
        const ogUrl = resolve(og && og.getAttribute('content'));
        if (ogUrl && looksLikePinImage(ogUrl)) {
          return [{ imageUrl: ogUrl, kind: 'image', title }];
        }

        const htmlImages = pinImageUrlsFromHtml(doc);
        const bestFromHtml = bestPinImageUrl(htmlImages);
        if (bestFromHtml) {
          return [{ imageUrl: bestFromHtml, kind: 'image', title }];
        }

        // 3. Pinterest's live closeup hook. Used when the page HTML scan fails.
        for (const selector of CLOSEUP_SELECTORS) {
          const url = resolve(imageIn(doc.querySelector(selector)));
          if (url && looksLikePinImage(url)) return [{ imageUrl: url, kind: 'image', title }];
        }

        // 4. Largest visible actual pinimg image.
        const largest = largestPinImage(doc);
        if (largest) return [{ imageUrl: largest, kind: 'image', title }];

        // 5. Last resort: og:image even if it does not look like a pin image.
        if (ogUrl && isPinMediaUrl(ogUrl)) return [{ imageUrl: ogUrl, kind: 'image', title }];

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
