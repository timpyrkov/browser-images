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

  function resolve(url) {
    return helpers.resolveImageUrl ? helpers.resolveImageUrl(url) : url || null;
  }

  /** Pinterest media file: https on *.pinimg.com (i.pinimg.com, v1.pinimg.com, ...). */
  function isPinMediaUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && PINIMG_HOST.test(parsed.hostname);
    } catch (error) {
      return false;
    }
  }

  /** Pinterest MP4: a pinimg host, a /videos/ path and an .mp4 file. */
  function isPinVideoUrl(url) {
    if (!isPinMediaUrl(url)) return false;
    const { pathname } = new URL(url);
    return pathname.startsWith('/videos/') && /\.mp4$/i.test(pathname);
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

  /**
   * Pinterest video URLs appear in the page HTML even in the app-shell state.
   * The HTML also holds text users write (descriptions, comments, links), so
   * the pattern pins the host itself - a run of host characters straight
   * after https:// - and every match is parsed and checked again: a text such
   * as https://evil.example/x?.pinimg.com/videos/a.mp4 is not a pinimg URL.
   */
  function videoUrlsFromHtml(doc) {
    const html = (doc.documentElement && (doc.documentElement.outerHTML || doc.documentElement.innerHTML)) || '';
    const urls = [];
    const seen = new Set();
    const regex = /https:\/\/(?:[a-z0-9-]+\.)*pinimg\.com\/videos\/[^"'\s<>\\]+?\.mp4/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = match[0];
      if (isPinVideoUrl(url) && !seen.has(url)) {
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

  /** Find the "more ideas" / "more like this" separator in the document. */
  function findMoreIdeasMarker(doc) {
    const byTestId = doc.querySelector('[data-test-id="more-ideas-container"]');
    if (byTestId) return byTestId;
    // Match the heading itself, not a page wrapper whose textContent merely
    // includes it: short text, and no child element carrying the same text.
    const re = /más ideas|more ideas|more like this|más como esto|similar ideas/i;
    const matches = (el) => {
      const text = (el.textContent || '').trim();
      return text.length < 80 && re.test(text);
    };
    for (const el of doc.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div, p')) {
      if (matches(el) && !Array.from(el.children || []).some(matches)) return el;
    }
    return null;
  }

  /** True if element a appears before element b in document order. */
  function isBefore(a, b) {
    if (!a || !b) return true;
    if (a === b) return false;
    if (typeof b.compareDocumentPosition !== 'function') return true;
    const preceding = (typeof Node !== 'undefined' && Node.DOCUMENT_POSITION_PRECEDING) || 2;
    return !!(b.compareDocumentPosition(a) & preceding);
  }

  /** Extract board/profile grid images directly from the rendered DOM.
   *  The gallery pins are the pinimg.com images that appear BEFORE the
   *  "more ideas" / "más ideas" separator in document order. */
  function extractGridImages(doc, href) {
    if (!isBoardOrProfilePage(href)) return null;

    const moreIdeas = findMoreIdeasMarker(doc);
    const seen = new Set();
    const images = [];

    // Walk document.images in document order. Collect large pinimg images
    // that appear before the "more ideas" separator.
    const candidates = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        if (!src || !isPinMediaUrl(src)) return false;
        if (img.naturalWidth < 150 || img.naturalHeight < 150) return false;
        if (moreIdeas && !isBefore(img, moreIdeas)) return false;
        return true;
      });

    for (const img of candidates) {
      // Grid thumbnails are 236x; the same hash is served at 736x (the size a
      // pin closeup uses), so download that instead of the small preview.
      const src = resolve((img.currentSrc || img.src).replace(/\/(?:236|474)x\//, '/736x/'));
      if (!src || seen.has(src)) continue;
      seen.add(src);
      images.push({ imageUrl: src, kind: 'image', title: img.alt || img.title || '' });
    }

    return images.length ? images : null;
  }

  /* ------------------------------------------------------------------ */
  /* Author: the pin's original creator, from Pinterest's own web API    */
  /* ------------------------------------------------------------------ */
  // Pinterest's web app reads pins and boards from same-origin /resource/
  // endpoints. Each pin there names its original creator (native_creator /
  // closeup_attribution / origin_pinner) separately from the person who saved
  // it (pinner), so the creator - not the board owner - is the author. The
  // requests run from inside the Pinterest tab, like the app's own.

  const BOARD_FEED_MAX_PAGES = 10;   // 25 pins per page
  const BOARD_FEED_GAP_MS = 400;

  function pageFetch() {
    /* global content */
    if (typeof content !== 'undefined' && content && typeof content.fetch === 'function') {
      return content.fetch.bind(content);
    }
    if (global && typeof global.__BI_PAGE_FETCH__ === 'function') return global.__BI_PAGE_FETCH__;
    return fetch.bind(global);
  }

  async function resourceGet(origin, resource, sourceUrl, handler, dataOptions, options = {}) {
    const doFetch = options.fetch || pageFetch();
    const url = `${origin}/resource/${resource}/get/?source_url=${encodeURIComponent(sourceUrl)}`
      + `&data=${encodeURIComponent(JSON.stringify({ options: dataOptions, context: {} }))}`;
    const response = await doFetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Pinterest-PWS-Handler': handler,
        'X-Pinterest-Source-Url': sourceUrl,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${resource}`);
    const json = await response.json();
    return (json && json.resource_response) || {};
  }

  /** The pin's original creator, or '' (the saver is not the author). */
  function creatorOf(pin) {
    if (!pin) return '';
    for (const key of ['native_creator', 'closeup_attribution', 'origin_pinner']) {
      const username = pin[key] && pin[key].username;
      if (username) return String(username);
    }
    return '';
  }

  function pinIdFrom(href) {
    const m = String(href || '').match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
  }

  /** Image hash in a pinimg URL (/236x/aa/bb/cc/HASH.jpg), shared by every size. */
  function imageHash(url) {
    try {
      return (new URL(url).pathname.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    } catch (error) {
      return '';
    }
  }

  async function pinAuthor(href, options = {}) {
    const id = pinIdFrom(href);
    if (!id) return '';
    try {
      const origin = new URL(href).origin;
      const res = await resourceGet(origin, 'PinResource', `/pin/${id}/`, 'www/pin/[id].js',
        { id, field_set_key: 'detailed' }, options);
      return creatorOf(res.data);
    } catch (error) {
      console.warn('[Pinterest] Pin author unavailable:', error.message);
      return '';
    }
  }

  /** image hash -> creator for the pins of a board (/{user}/{board}/). */
  async function boardAuthors(href, options = {}) {
    const authors = new Map();
    try {
      const url = new URL(href);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) return authors;            // profiles: no board feed
      const [username, slug] = parts.map((p) => decodeURIComponent(p));
      const sourceUrl = `/${parts[0]}/${parts[1]}/`;
      const handler = 'www/[username]/[slug].js';
      const board = await resourceGet(url.origin, 'BoardResource', sourceUrl, handler,
        { username, slug, field_set_key: 'detailed' }, options);
      const boardId = board.data && board.data.id;
      if (!boardId) return authors;
      let bookmark = null;
      for (let page = 0; page < BOARD_FEED_MAX_PAGES; page++) {
        if (page) await new Promise((resolve) => setTimeout(resolve, BOARD_FEED_GAP_MS));
        const feed = await resourceGet(url.origin, 'BoardFeedResource', sourceUrl, handler, {
          board_id: boardId, board_url: sourceUrl, page_size: 25, field_set_key: 'react_grid_pin',
          ...(bookmark ? { bookmarks: [bookmark] } : {}),
        }, options);
        for (const pin of feed.data || []) {
          const author = pin && pin.type === 'pin' ? creatorOf(pin) : '';
          if (!author) continue;
          for (const image of Object.values(pin.images || {})) {
            const hash = image && imageHash(image.url);
            if (hash) authors.set(hash, author);
          }
        }
        bookmark = feed.bookmark;
        if (!bookmark || bookmark === '-end-' || !(feed.data || []).length) break;
      }
    } catch (error) {
      console.warn('[Pinterest] Board authors unavailable:', error.message);
    }
    return authors;
  }

  function createPinterestParser() {
    return {
      domain: 'pinterest.com',
      label: 'Pinterest',
      // pinimg.com refuses bursts, so wait for each file to finish before the
      // next one and never go faster than this, whatever the global delay.
      downloadPolicy: { awaitCompletion: true, minDelaySeconds: 1.5 },
      // Never fall back to an og:image or page image from another host.
      disableGenericFallback: true,
      isMainImageView(hostname, pathname) {
        return /(^|\.)pinterest\./i.test(hostname || '') && isPinPage(pathname);
      },
      isIndexView(hostname, pathname) {
        return /(^|\.)pinterest\./i.test(hostname || '') && isBoardOrProfilePage(pathname);
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      async extractIndexLinks(doc, href, options = {}) {
        const images = extractGridImages(doc, href);
        if (!images) return [];
        // Board pins: each image's creator from the board feed, matched by
        // image hash. Pins it cannot match keep their plain names.
        const authors = await boardAuthors(href, options);
        return { images: images.map((item) => withAuthor(item, authors.get(imageHash(item.imageUrl)))) };
      },
      async extractImageUrls(doc, href, options = {}) {
        const media = pinMedia(doc, href);
        if (!media.length) return media;
        const author = await pinAuthor(href || (doc.location && doc.location.href), options);
        return media.map((item) => withAuthor(item, author));
      },
    };
  }

  function withAuthor(item, author) {
    return author ? { ...item, author } : item;
  }

  /** The pin page's own media: videos first, then the closeup image. */
  function pinMedia(doc, href) {
    if (!isPinPage(href || (doc.location && doc.location.pathname))) return [];
    const title = doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : '';

    // 1. Video / animated pins. Pinterest embeds MP4 URLs in the HTML even in
    // the app-shell state. Group variants by base video ID and return the
    // best quality for each distinct video.
    const domVideos = closeupVideoUrls(doc);
    const htmlVideos = videoUrlsFromHtml(doc);
    const allVideos = [...new Set([...domVideos, ...htmlVideos])].filter(isPinVideoUrl);
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
  }

  global.PINTEREST_INTERNALS = { creatorOf, imageHash, pinAuthor, boardAuthors };

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createPinterestParser());
  } else {
    global.createPinterestParser = createPinterestParser;
  }
})(typeof self !== 'undefined' ? self : this);
