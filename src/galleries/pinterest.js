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
// 4. Board / profile pages: Pinterest renders these as a JS app-shell, so the
//    background script cannot fetch individual pin pages. Instead, the grid
//    thumbnail images are extracted directly in the content script and
//    downloaded as-is. Suggestions below "more ideas" are excluded.
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

  /** True if this is a board or profile index page. */
  function isBoardOrProfilePage(href) {
    try {
      const pathname = new URL(href, 'https://www.pinterest.com').pathname;
      if (!/(^|\.)pinterest\./i.test(new URL(href, 'https://www.pinterest.com').hostname)) return false;
      // Exclude known non-gallery paths.
      if (/^\/(business|about|careers|policy|legal|community|settings|search)\//.test(pathname)) return false;
      if (/^\/pin\/\d+/.test(pathname)) return false;
      // /username/ or /username/board-name/
      return /^\/[^/]+\/?$/.test(pathname) || /^\/[^/]+\/[^/]+\/?$/.test(pathname);
    } catch (error) {
      return false;
    }
  }

  /** Read the board pin count from the page header (e.g. "7 Pines"). */
  function boardPinCount(doc) {
    const el = doc.querySelector('[data-test-id="pin-count"]');
    if (!el) return null;
    const text = (el.textContent || '').toLowerCase();
    if (text.includes('k')) {
      const m = text.match(/([\d.,]+)\s*k/);
      if (m) return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1000);
    }
    if (text.includes('m')) {
      const m = text.match(/([\d.,]+)\s*m/);
      if (m) return Math.round(parseFloat(m[1].replace(/,/g, '.')) * 1000000);
    }
    const digits = text.match(/\d+/);
    return digits ? parseInt(digits[0], 10) : null;
  }

  /** Extract board/profile grid images directly from the rendered DOM.
   *  Limited to the board's stated pin count so suggestions below "more ideas"
   *  are not collected. */
  function extractGridImages(doc, href) {
    if (!isBoardOrProfilePage(href)) return null;

    const grid = doc.querySelector('[data-test-id="grid"]')
      || doc.querySelector('[data-test-id="feed"]')
      || doc.querySelector('[data-test-id="masonry-container"]');
    if (!grid) return null;

    const moreIdeas = doc.querySelector('[data-test-id="more-ideas-container"]');
    const maxPins = boardPinCount(doc) || Number.MAX_SAFE_INTEGER;
    const seen = new Set();
    const images = [];

    // Modern Pinterest board pages wrap each pin in gated-pin-rep / gated-pin-image.
    const pinReps = Array.from(grid.querySelectorAll('[data-test-id="gated-pin-rep"], [data-test-id="gated-pin-image"]'));
    for (const rep of pinReps) {
      if (images.length >= maxPins) break;
      if (moreIdeas && moreIdeas.contains(rep)) continue;
      const img = rep.tagName === 'IMG' ? rep : rep.querySelector('img');
      if (!img) continue;
      const src = resolve(img.currentSrc || img.src);
      if (!src || !isPinMediaUrl(src) || seen.has(src)) continue;
      seen.add(src);
      images.push({ imageUrl: src, kind: 'image', title: img.alt || img.title || '' });
    }

    // Fallback: if no gated-pin reps were found, grab the largest images inside
    // the grid, excluding the more-ideas section.
    if (!images.length) {
      const candidates = Array.from(grid.querySelectorAll('img'))
        .filter((img) => {
          if (moreIdeas && moreIdeas.contains(img)) return false;
          const src = img.currentSrc || img.src;
          return src && isPinMediaUrl(src) && img.naturalWidth >= 150 && img.naturalHeight >= 150;
        })
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      for (const img of candidates) {
        if (images.length >= maxPins) break;
        const src = resolve(img.currentSrc || img.src);
        if (!src || seen.has(src)) continue;
        seen.add(src);
        images.push({ imageUrl: src, kind: 'image', title: img.alt || img.title || '' });
      }
    }

    return images.length ? images : null;
  }

  function createPinterestParser() {
    return {
      domain: 'pinterest.com',
      label: 'Pinterest',
      isMainImageView(hostname, pathname) {
        return /(^|\.)pinterest\./i.test(hostname || '') && isPinPage(pathname);
      },
      isIndexView(hostname, pathname) {
        return /(^|\.)pinterest\./i.test(hostname || '') && isBoardOrProfilePage(pathname);
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      parseDeviationHtml() {
        // Pinterest board/profile pages cannot be parsed from raw HTML: the
        // server returns an app shell and the pin grid is rendered by JS. This
        // method exists only so background.js recognises the parser supports
        // index pages; actual grid images are extracted in the content script.
        return null;
      },
      extractIndexLinks(doc, href) {
        const images = extractGridImages(doc, href);
        return images ? { images } : [];
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

        // 2. Canonical og:image. This is the most reliable source for a full
        // page load and downloads successfully with the browser's downloader.
        const og = doc.querySelector("meta[property='og:image']");
        const ogUrl = resolve(og && og.getAttribute('content'));
        if (ogUrl && isPinMediaUrl(ogUrl)) {
          return [{ imageUrl: ogUrl, kind: 'image', title }];
        }

        // 3. Pinterest's live closeup hook. Used when og:image is missing (e.g.
        // in-app navigation where the <head> was not rewritten).
        for (const selector of CLOSEUP_SELECTORS) {
          const url = resolve(imageIn(doc.querySelector(selector)));
          if (url && isPinMediaUrl(url)) return [{ imageUrl: url, kind: 'image', title }];
        }

        // 4. Largest visible pinimg image.
        const largest = largestPinImage(doc);
        if (largest) return [{ imageUrl: largest, kind: 'image', title }];

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
