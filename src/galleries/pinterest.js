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
// Multi-image pins render several closeup-sized images in a carousel, so we
// collect every large pinimg.com image in the closeup region. Video pins expose
// a <video> element. Board / profile / search pages are index pages: we walk
// their grids and collect individual pin links, then parse each pin's HTML.
(function (global) {
  'use strict';

  const helpers = (global && global.GALLERY_HELPERS) || {};

  /** Last path segment, decoded, for use as a download filename. */
  function basenameFromUrl(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch (error) {
      return '';
    }
  }

  // Pinterest's own hooks around the closeup image, best first.
  const CLOSEUP_SELECTORS = [
    '[data-test-id="pin-closeup-image"]',
    '[data-test-id="closeup-image"]',
    '[data-test-id="visual-search-pin-image"]',
  ];

  // The closeup container is wider than the surrounding "more like this" grid.
  const CLOSEUP_CONTAINER_SELECTORS = [
    '[data-test-id="pin-closeup"]',
    '[data-test-id="closeup"]',
  ];

  // On board/profile pages we only want pins that belong to the board itself,
  // not the "more ideas" / "more like this" infinite suggestions below it.
  const BOARD_GRID_SELECTORS = [
    '[data-test-id="board-feed"]',
    '[data-test-id="board-section"]',
    '[data-test-id="boardPins"]',
    '[data-test-id="board-pin-grid"]',
    '[data-test-id="board-feed-grid"]',
    '[data-test-id="grid"]', // the first grid on a board page is usually the board
  ];

  const MORE_IDEAS_SELECTORS = [
    '[data-test-id="more-ideas-feed"]',
    '[data-test-id="more-ideas"]',
    '[data-test-id="more-like-this"]',
    '[data-test-id="related-pins"]',
  ];

  const PINIMG_HOST = /(^|\.)pinimg\.com$/i;
  const PINTEREST_HOST = /(^|\.)pinterest\./i;
  const PIN_URL = /\/pin\/(\d+)(?:[/?#]|$)/;

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

  function pinIdFromUrl(href) {
    const match = String(href || '').match(PIN_URL);
    return match ? match[1] : null;
  }

  /**
   * Use the image URL exactly as Pinterest rendered it (236x, 474x, 736x, …).
   * Rewriting the path to /originals/ often produces 404s because the original
   * hash layout differs, so we intentionally keep the rendered URL.
   */
  function bestPinImageUrl(rawUrl) {
    return resolve(rawUrl);
  }

  /** True if this is a /pin/{id} detail page. */
  function isPinPage(pathname) {
    return PIN_URL.test(pathname || '');
  }

  /** True if this looks like a user board or profile grid page. */
  function isBoardPage(pathname) {
    const parts = String(pathname || '').replace(/^\/+/, '').split('/').filter(Boolean);
    if (!parts.length) return false;
    const first = parts[0].toLowerCase();
    if (['pin', 'search', 'ideas', 'shop', 'about', 'careers', 'blog', 'business'].includes(first)) {
      return false;
    }
    // /username/  or  /username/board-name/
    return parts.length <= 2;
  }

  function isSearchPage(pathname) {
    return /^\/search\b/i.test(pathname || '');
  }

  /** Pixel area from natural size, falling back to rendered size. */
  function imageArea(img) {
    const w = img.naturalWidth || img.width || img.clientWidth || 0;
    const h = img.naturalHeight || img.height || img.clientHeight || 0;
    return w * h;
  }

  /**
   * Collect every large pinimg.com image inside the closeup region. Multi-image
   * pins render all carousel images at closeup size, so this naturally yields
   * one item for a single pin and several for a carousel. This only runs when
   * the specific closeup selectors above did not match, and only if we can
   * identify a closeup container, to avoid harvesting "more like this" thumbs.
   */
  function collectCloseupImages(doc) {
    let container = null;
    for (const selector of CLOSEUP_CONTAINER_SELECTORS) {
      container = doc.querySelector(selector);
      if (container) break;
    }
    if (!container) return [];

    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        if (!src || !isPinImage(src)) return false;
        if (!container.contains(img)) return false;
        const w = img.naturalWidth || img.width || img.clientWidth || 0;
        const h = img.naturalHeight || img.height || img.clientHeight || 0;
        return w >= 300 && h >= 150;
      })
      .sort((a, b) => imageArea(b) - imageArea(a));

    const seen = new Set();
    const urls = [];
    for (const img of images) {
      const src = img.currentSrc || img.src;
      const resolved = bestPinImageUrl(src);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        urls.push(resolved);
      }
    }
    return urls;
  }

  /**
   * Largest rendered pinimg image on the page. Used when the test-id hooks
   * change: the closeup is always the biggest image in a pin view, well clear
   * of the 236x/474x thumbnails in the "more like this" grid below it.
   */
  function largestPinImage(doc) {
    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        const w = img.naturalWidth || img.width || img.clientWidth || 0;
        const h = img.naturalHeight || img.height || img.clientHeight || 0;
        return src && isPinImage(src) && w > 300 && h > 150;
      })
      .sort((a, b) => imageArea(b) - imageArea(a));
    return images.length ? bestPinImageUrl(images[0].currentSrc || images[0].src) : null;
  }

  /** Any <video> element inside the closeup region, or the page as fallback. */
  function collectCloseupVideos(doc) {
    let container = null;
    for (const selector of CLOSEUP_CONTAINER_SELECTORS) {
      container = doc.querySelector(selector);
      if (container) break;
    }
    const selectors = ['video', '[data-test-id*="video"]', '[data-test-id*="Video"]'];
    const videos = [];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of Array.from(doc.querySelectorAll ? doc.querySelectorAll(sel) : [])) {
        if (seen.has(el)) continue;
        if (el.tagName !== 'VIDEO' && !container) continue;
        if (container && !container.contains(el) && el.tagName !== 'VIDEO') continue;
        seen.add(el);
        videos.push(el);
      }
    }
    const urls = [];
    const urlSeen = new Set();
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (src && !urlSeen.has(src)) {
        urlSeen.add(src);
        urls.push(src);
      }
      for (const source of video.querySelectorAll ? video.querySelectorAll('source') : []) {
        const ssrc = source.src || source.getAttribute('src');
        if (ssrc && !urlSeen.has(ssrc)) {
          urlSeen.add(ssrc);
          urls.push(ssrc);
        }
      }
    }
    return urls;
  }

  /** Try to parse Pinterest's embedded JSON state. */
  function extractPwsData(html) {
    if (!html) return null;
    const marker = 'id="__PWS_DATA__"';
    const at = html.indexOf(marker);
    if (at === -1) return null;
    const open = html.indexOf('>', at);
    const close = html.indexOf('</script>', open);
    if (open === -1 || close === -1) return null;
    try {
      return JSON.parse(html.slice(open + 1, close));
    } catch (error) {
      return null;
    }
  }

  /** Find the pin object in the various places Pinterest stashes it. */
  function findPinInState(data, pinId) {
    if (!data || !pinId) return null;
    // Older layout: props.initialReduxState.pins[pinId]
    const reduxPins = data.props && data.props.initialReduxState && data.props.initialReduxState.pins;
    if (reduxPins && reduxPins[pinId]) return reduxPins[pinId];
    // Newer routeTree layout: walk the tree for pin objects
    if (Array.isArray(data.routeTree)) {
      const stack = [...data.routeTree];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (String(node.id) === pinId && (node.images || node.videos || node.closeup_image_url)) {
          return node;
        }
        if (Array.isArray(node)) {
          stack.push(...node);
        } else {
          for (const key of Object.keys(node)) {
            const value = node[key];
            if (value && typeof value === 'object') {
              stack.push(value);
            }
          }
        }
      }
    }
    return null;
  }

  /** Build image/video items from a Pinterest pin state object. */
  function itemsFromPinState(pin) {
    if (!pin) return [];
    const items = [];
    const title = pin.title || pin.grid_title || pin.description || '';

    if (pin.videos) {
      // video_list is { V_720P: {url,...}, V_360P: {...}, ... }
      const list = pin.videos.video_list || pin.videos;
      const renditions = Object.values(list).filter((v) => v && v.url);
      const best = renditions
        .slice()
        .sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0))[0];
      if (best) {
        items.push({
          url: best.url,
          kind: 'video',
          width: best.width,
          height: best.height,
          title,
        });
      }
    }

    if (pin.images) {
      const orig = pin.images.orig || pin.images['736x'] || pin.images['474x'] || pin.images['236x'];
      if (orig && orig.url) {
        items.push({
          url: bestPinImageUrl(orig.url),
          kind: 'image',
          width: orig.width,
          height: orig.height,
          title,
        });
      }
    }

    // Story / multi-page pins
    if (pin.story_pin_data && Array.isArray(pin.story_pin_data.pages)) {
      pin.story_pin_data.pages.forEach((page) => {
        if (!page || !page.blocks) return;
        page.blocks.forEach((block) => {
          const img = block && block.image && (block.image.original || block.image['1200x'] || block.image['736x']);
          if (img && img.url) {
            items.push({
              url: bestPinImageUrl(img.url),
              kind: 'image',
              width: img.width,
              height: img.height,
              title,
            });
          }
        });
      });
    }

    return items;
  }

  /** All pin links in a board / profile / search grid, scoped to the board grid
   *  itself and not the infinite "more ideas" suggestions below it. */
  function pinHref(href) {
    const match = String(href || '').match(PIN_URL);
    return match ? `https://www.pinterest.com/pin/${match[1]}/` : null;
  }

  function findBoardGrid(doc) {
    if (!doc.querySelector) return null;
    for (const selector of BOARD_GRID_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function findMoreIdeasSection(doc) {
    if (!doc.querySelector) return null;
    for (const selector of MORE_IDEAS_SELECTORS) {
      const el = doc.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * Collect pin links in document order, stopping once the board's stated pin
   * count is reached. Board pins are rendered before the "more ideas" infinite
   * suggestions, so the first N unique links are the board pins.
   */
  function collectPinLinks(doc, maxLinks) {
    const links = [];
    const seen = new Set();
    if (!doc.querySelectorAll) return links;

    const moreIdeas = findMoreIdeasSection(doc);
    const anchors = Array.from(doc.querySelectorAll('a[href*="/pin/"]'));
    for (const a of anchors) {
      if (moreIdeas && moreIdeas.contains(a)) continue;
      const url = pinHref(a.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push(url);
      if (maxLinks && links.length >= maxLinks) break;
    }
    return links;
  }

  /** Try to read the published pin count from the board header ("7 Pins"). */
  function expectedIndexTotal(doc, href) {
    if (!doc.querySelectorAll) return null;
    // Pinterest uses obfuscated class names, but the pin count text itself is
    // a stable anchor: it ends in "Pins" / "pines" / "pin" etc. and contains a
    // small number, optionally with K/M suffixes.
    const nodes = doc.querySelectorAll('span, h1, h2, h3, div, a');
    let best = null;
    const candidates = [];
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (text.length > 50 || text.length < 3) continue;
      // Match "7 Pins", "1.2K Pins", "7 Pines", "7 pines" etc.
      const match = /^(\d[\d.,\u00a0\u202f ]*)(?:\s*([KM]))?\s*(?:pin|pins|pines|pinn|pinnen)/i.exec(text);
      if (!match) continue;
      const suffix = (match[2] || '').toUpperCase();
      const digits = match[1].replace(/[\u00a0\u202f ]/g, '');
      let value;
      if (suffix) {
        value = parseFloat(digits.replace(',', '.')) * (suffix === 'M' ? 1e6 : 1e3);
      } else {
        value = parseInt(digits.replace(/[.,]/g, ''), 10);
      }
      if (!Number.isFinite(value) || value <= 0) continue;
      candidates.push(text);
      if (!best || text.length < best.length) best = { value: Math.round(value), length: text.length };
    }
    console.log('[Pinterest] pin-count candidates:', candidates.slice(0, 10), 'chosen:', best);
    return best ? best.value : null;
  }

  /** Candidate controls that advance an index page to its next batch. */
  function nextPageButtons(doc) {
    return Array.from(doc.querySelectorAll ? doc.querySelectorAll('button') : [])
      .filter((el) => {
        const text = (el.textContent || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        return /(load more|more pins|show more|next)/.test(text + ' ' + label);
      })
      .filter((el) => !el.disabled);
  }

  async function collectAllPinLinks(doc, href, options = {}) {
    const paginate = options.paginate !== false;
    const maxRounds = Math.max(1, options.maxRounds || 4000);
    const settleMs = Math.max(100, options.settleMs || 600);
    const view = options.view || (typeof window !== 'undefined' ? window : null);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const stopped = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;

    const target = expectedIndexTotal(doc, href);
    console.log('[Pinterest] board target pin count:', target, 'href:', href);

    const seen = new Set();
    const addNew = (newLinks) => {
      for (const url of newLinks) {
        if (!seen.has(url)) {
          seen.add(url);
        }
      }
    };

    // First pass: collect links already in the DOM in document order.
    addNew(collectPinLinks(doc, target || null));
    report(seen.size, target);
    console.log('[Pinterest] initial links collected:', seen.size, 'target:', target);
    if (!paginate) return Array.from(seen).slice(0, target || seen.size);

    const startY = (view && view.scrollY) || 0;
    let idle = 0;
    const idleLimit = Math.max(1, options.idleRounds || 6);

    for (let round = 0; round < maxRounds && idle < idleLimit && !stopped(); round++) {
      const before = seen.size;
      let moved = false;

      if (view && typeof view.scrollTo === 'function') {
        const from = view.scrollY || 0;
        const step = Math.max(400, Math.floor((view.innerHeight || 800) * 0.8));
        view.scrollTo(0, from + step);
        await wait(settleMs);
        moved = (view.scrollY || 0) !== from;
        // Cap each collection pass at the board size so suggestions further down
        // the DOM are ignored once we have all board pins.
        addNew(collectPinLinks(doc, target || null));
      }

      if (seen.size === before && !moved) {
        for (const button of nextPageButtons(doc)) {
          try { button.click(); } catch (error) { continue; }
          await wait(settleMs);
          addNew(collectPinLinks(doc, target || null));
          if (seen.size > before) break;
        }
      }

      if (seen.size > before || moved) {
        idle = 0;
      } else {
        idle++;
      }
      report(seen.size, target);
      console.log('[Pinterest] round', round, 'links', seen.size, 'target', target);
      // Stop once every board pin has been collected.
      if (target && seen.size >= target) break;
    }

    if (view && typeof view.scrollTo === 'function') view.scrollTo(0, startY);
    const result = Array.from(seen).slice(0, target || seen.size);
    console.log('[Pinterest] final board links:', result.length, result.slice(0, 10));
    return result;
  }

  /** Build media items from the live DOM of a pin page. */
  function extractPinMediaFromDom(doc, href) {
    const title = doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : '';

    console.log('[Pinterest] extractPinMediaFromDom', href, 'images:', (doc.images || []).length);

    const videoUrls = collectCloseupVideos(doc);
    console.log('[Pinterest] closeup videos found:', videoUrls.length, videoUrls);
    if (videoUrls.length) {
      return videoUrls.map((url) => ({ url, kind: 'video', title }));
    }

    // Try Pinterest's own closeup hooks first; this is the path that worked for
    // single-image pins before any multi-image work was added.
    for (const selector of CLOSEUP_SELECTORS) {
      const el = doc.querySelector(selector);
      const url = resolve(imageIn(el));
      console.log('[Pinterest] closeup selector', selector, '=>', url ? url.slice(0, 120) : null);
      if (url) return [{ url: bestPinImageUrl(url), kind: 'image', title }];
    }

    // Multi-image / carousel pins: if the specific hook did not match but we
    // found a closeup container, collect every large image inside it.
    const imageUrls = collectCloseupImages(doc);
    console.log('[Pinterest] closeup container images found:', imageUrls.length, imageUrls);
    if (imageUrls.length) {
      return imageUrls.map((url) => ({ url, kind: 'image', title }));
    }

    const largest = largestPinImage(doc);
    console.log('[Pinterest] largest pinimg image:', largest ? largest.slice(0, 120) : null);
    if (largest) return [{ url: largest, kind: 'image', title }];

    const og = doc.querySelector("meta[property='og:image']");
    const fallback = resolve(og && og.getAttribute('content'));
    console.log('[Pinterest] og:image fallback:', fallback ? fallback.slice(0, 120) : null);
    return fallback ? [{ url: bestPinImageUrl(fallback), kind: 'image', title }] : [];
  }

  /** Parse raw pin HTML for background fetches (service worker / fetch path). */
  function parsePinHtml(html, href) {
    const pinId = pinIdFromUrl(href);
    console.log('[Pinterest] parsePinHtml', href, 'pinId:', pinId, 'html length:', html ? html.length : 0);
    const data = extractPwsData(html);
    console.log('[Pinterest] __PWS_DATA__ found:', !!data);
    const pin = data ? findPinInState(data, pinId) : null;
    if (pin) {
      const items = itemsFromPinState(pin);
      console.log('[Pinterest] parsed from PWS data:', items.length, items.map((i) => i.url.slice(0, 120)));
      return items;
    }
    // Fallback: look for JSON-LD or og:image.
    const ogMatch = html.match(/<meta[^>]*property=['"]og:image['"][^>]*content=['"]([^'"]+)/i)
      || html.match(/<meta[^>]*content=['"]([^'"]*)['"][^>]*property=['"]og:image['"]/i);
    console.log('[Pinterest] og:image match:', ogMatch ? ogMatch[1].slice(0, 120) : null);
    if (ogMatch && ogMatch[1]) {
      return [{ url: bestPinImageUrl(ogMatch[1]), kind: 'image' }];
    }
    return [];
  }

  function createPinterestParser() {
    return {
      domain: 'pinterest.com',
      label: 'Pinterest',
      isMainImageView(hostname, pathname) {
        return PINTEREST_HOST.test(hostname || '') && isPinPage(pathname);
      },
      isIndexView(hostname, pathname) {
        return PINTEREST_HOST.test(hostname || '') && (isBoardPage(pathname) || isSearchPage(pathname));
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      extractImageUrls(doc, href) {
        if (!isPinPage(href || doc.location && doc.location.pathname)) return [];
        const media = extractPinMediaFromDom(doc, href);
        return media.map((item) => ({
          imageUrl: item.url,
          kind: item.kind,
          title: item.title || (doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : ''),
          width: item.width || null,
          height: item.height || null,
        }));
      },
      async extractIndexLinks(doc, href, options = {}) {
        return collectAllPinLinks(doc, href, options);
      },
      expectedIndexTotal(doc, href) {
        return expectedIndexTotal(doc, href);
      },
      indexSearchTerm(doc, href) {
        try {
          return new URL(href, 'https://www.pinterest.com').searchParams.get('q') || null;
        } catch (error) {
          return null;
        }
      },
      indexSortOrder() {
        return null;
      },
      parseDeviationHtml(html, href) {
        const items = parsePinHtml(html, href);
        if (!items.length) return null;
        const pageTitle = '';
        return {
          images: items.map((item) => ({
            imageUrl: item.url,
            filename: basenameFromUrl(item.url),
            title: item.title || pageTitle,
            width: item.width || null,
            height: item.height || null,
          })),
          title: pageTitle,
          unavailable: null,
        };
      },
    };
  }

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createPinterestParser());
  } else {
    global.createPinterestParser = createPinterestParser;
  }
})(typeof self !== 'undefined' ? self : this);
