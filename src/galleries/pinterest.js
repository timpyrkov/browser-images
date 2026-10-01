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

  const PINIMG_HOST = /(^|\.)pinimg\.com$/i;
  const PINTEREST_HOST = /(^|\.)pinterest\./i;
  const PIN_URL = /\/pin\/(\d+)(?:[/?#]|$)/;

  function resolve(url) {
    return helpers.resolveImageUrl ? helpers.resolveImageUrl(url) : url || null;
  }

  /** The <img> for a hook element, which is usually a wrapping <div>. */
  function imageIn(el) {
    if (!el) return null;
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
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
   * Pinterest image URLs embed the requested size in the path:
   *   https://i.pinimg.com/236x/aa/bb/cc/name.jpg
   * Upgrade any size segment to /originals/ to get the unscaled file.
   */
  function originalPinImageUrl(rawUrl) {
    const resolved = resolve(rawUrl);
    if (!resolved) return null;
    try {
      const url = new URL(resolved);
      if (!PINIMG_HOST.test(url.hostname)) return resolved;
      const parts = url.pathname.split('/');
      // /{size}/{hash1}/{hash2}/{hash3}/{name}.jpg
      if (parts.length < 6) return resolved;
      if (parts[1] === 'originals') return resolved;
      parts[1] = 'originals';
      return `${url.origin}${parts.join('/')}${url.search}`;
    } catch (error) {
      return resolved;
    }
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

  /**
   * Collect every large pinimg.com image inside the closeup region. Multi-image
   * pins render all carousel images at closeup size, so this naturally yields
   * one item for a single pin and several for a carousel.
   */
  function collectCloseupImages(doc) {
    let container = null;
    for (const selector of CLOSEUP_CONTAINER_SELECTORS) {
      container = doc.querySelector(selector);
      if (container) break;
    }

    const images = Array.from(doc.images || [])
      .filter((img) => {
        const src = img.currentSrc || img.src;
        if (!src || !isPinImage(src)) return false;
        // Restrict to the closeup area when we found it, otherwise use a size
        // threshold that excludes the smaller "more like this" thumbnails.
        if (container && !container.contains(img)) return false;
        return img.naturalWidth >= 300 && img.naturalHeight >= 150;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);

    const seen = new Set();
    const urls = [];
    for (const img of images) {
      const src = img.currentSrc || img.src;
      const orig = originalPinImageUrl(src);
      if (!seen.has(orig)) {
        seen.add(orig);
        urls.push(orig);
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
        return src && isPinImage(src) && img.naturalWidth > 300 && img.naturalHeight > 150;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return images.length ? originalPinImageUrl(images[0].currentSrc || images[0].src) : null;
  }

  /** Any <video> element inside the closeup region, or the page as fallback. */
  function collectCloseupVideos(doc) {
    let container = null;
    for (const selector of CLOSEUP_CONTAINER_SELECTORS) {
      container = doc.querySelector(selector);
      if (container) break;
    }
    const videos = Array.from(doc.querySelectorAll ? doc.querySelectorAll('video') : [])
      .filter((v) => !container || container.contains(v));
    const urls = [];
    const seen = new Set();
    for (const video of videos) {
      const src = video.currentSrc || video.src;
      if (src && !seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
      for (const source of video.querySelectorAll ? video.querySelectorAll('source') : []) {
        const ssrc = source.src || source.getAttribute('src');
        if (ssrc && !seen.has(ssrc)) {
          seen.add(ssrc);
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
          url: originalPinImageUrl(orig.url),
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
              url: originalPinImageUrl(img.url),
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

  /** All pin links in a board / profile / search grid, optionally scoped to an owner. */
  function pinHref(href) {
    const match = String(href || '').match(PIN_URL);
    return match ? `https://www.pinterest.com/pin/${match[1]}/` : null;
  }

  function collectPinLinks(doc, href, sink) {
    const links = sink instanceof Set ? sink : new Set();
    if (!doc.querySelectorAll) return links;
    Array.from(doc.querySelectorAll('a[href*="/pin/"]')).forEach((a) => {
      const url = pinHref(a.href);
      if (url) links.add(url);
    });
    return links;
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

    const links = new Set();
    collectPinLinks(doc, href, links);
    report(links.size, null);
    if (!paginate) return Array.from(links);

    const startY = (view && view.scrollY) || 0;
    let idle = 0;
    const idleLimit = Math.max(1, options.idleRounds || 6);

    for (let round = 0; round < maxRounds && idle < idleLimit && !stopped(); round++) {
      const before = links.size;
      let moved = false;

      if (view && typeof view.scrollTo === 'function') {
        const from = view.scrollY || 0;
        const step = Math.max(400, Math.floor((view.innerHeight || 800) * 0.8));
        view.scrollTo(0, from + step);
        await wait(settleMs);
        moved = (view.scrollY || 0) !== from;
        collectPinLinks(doc, href, links);
      }

      if (links.size === before && !moved) {
        for (const button of nextPageButtons(doc)) {
          try { button.click(); } catch (error) { continue; }
          await wait(settleMs);
          collectPinLinks(doc, href, links);
          if (links.size > before) break;
        }
      }

      if (links.size > before || moved) {
        idle = 0;
      } else {
        idle++;
      }
      report(links.size, null);
    }

    if (view && typeof view.scrollTo === 'function') view.scrollTo(0, startY);
    return Array.from(links);
  }

  /** Build media items from the live DOM of a pin page. */
  function extractPinMediaFromDom(doc, href) {
    const title = doc.title ? doc.title.replace(/\s*\|\s*Pinterest\s*$/i, '').trim() : '';

    const videoUrls = collectCloseupVideos(doc);
    if (videoUrls.length) {
      return videoUrls.map((url) => ({ url, kind: 'video', title }));
    }

    const imageUrls = collectCloseupImages(doc);
    if (imageUrls.length) {
      return imageUrls.map((url) => ({ url, kind: 'image', title }));
    }

    for (const selector of CLOSEUP_SELECTORS) {
      const url = resolve(imageIn(doc.querySelector(selector)));
      if (url) return [{ url: originalPinImageUrl(url), kind: 'image', title }];
    }

    const largest = largestPinImage(doc);
    if (largest) return [{ url: largest, kind: 'image', title }];

    const og = doc.querySelector("meta[property='og:image']");
    const fallback = resolve(og && og.getAttribute('content'));
    return fallback ? [{ url: originalPinImageUrl(fallback), kind: 'image', title }] : [];
  }

  /** Parse raw pin HTML for background fetches (service worker / fetch path). */
  function parsePinHtml(html, href) {
    const pinId = pinIdFromUrl(href);
    const data = extractPwsData(html);
    const pin = data ? findPinInState(data, pinId) : null;
    if (pin) {
      return itemsFromPinState(pin);
    }
    // Fallback: look for JSON-LD or og:image.
    const ogMatch = html.match(/<meta[^>]*property=['"]og:image['"][^>]*content=['"]([^'"]+)/i)
      || html.match(/<meta[^>]*content=['"]([^'"]*)['"][^>]*property=['"]og:image['"]/i);
    if (ogMatch && ogMatch[1]) {
      return [{ url: originalPinImageUrl(ogMatch[1]), kind: 'image' }];
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
