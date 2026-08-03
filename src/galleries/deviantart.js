// galleries/deviantart.js
// DeviantArt-specific parser for the Browser Images extension.
(function (global) {
  'use strict';

  const helpers = (global && global.GALLERY_HELPERS) || {};
  const naming = (global && global.MEDIA_NAMING)
    || (typeof require === 'function' ? require('../naming.js') : null);

  /* ------------------------------------------------------------------ */
  /* 1. Reading the page state                                          */
  /* ------------------------------------------------------------------ */

  function decodeJsStringLiteral(literal) {
    const body = literal.slice(1, -1);
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') { out += ch; continue; }
      const next = body[++i];
      if (next === 'u') { out += String.fromCharCode(parseInt(body.substr(i + 1, 4), 16)); i += 4; }
      else if (next === 'x') { out += String.fromCharCode(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
      else if (next in simple) { out += simple[next]; }
      else { out += next; }
    }
    return out;
  }

  function extractInitialState(html) {
    const marker = 'window.__INITIAL_STATE__';
    const at = html.indexOf(marker);
    if (at === -1) throw new Error('__INITIAL_STATE__ not found');

    const parseCall = html.indexOf('JSON.parse("', at);
    if (parseCall === -1) throw new Error('Unexpected __INITIAL_STATE__ format');

    let i = parseCall + 'JSON.parse("'.length;
    while (i < html.length) {
      if (html[i] === '\\') i += 2;
      else if (html[i] === '"') break;
      else i++;
    }
    const literal = html.slice(parseCall + 'JSON.parse('.length, i + 1);
    return JSON.parse(decodeJsStringLiteral(literal));
  }

  function getDeviantArtStateFromPage(doc) {
    try {
      const html = doc && doc.documentElement && doc.documentElement.outerHTML;
      if (!html) return null;
      return extractInitialState(html);
    } catch (error) {
      return null;
    }
  }

  function getDeviantArtStateFromWindow(doc) {
    return new Promise((resolve) => {
      let resolved = false;
      function done(state) {
        if (resolved) return;
        resolved = true;
        window.removeEventListener('message', handler);
        resolve(state);
      }

      const handler = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        if (event.data && event.data.type === 'BI_INITIAL_STATE') {
          done(event.data.state);
        }
      };
      window.addEventListener('message', handler);

      const script = doc.createElement('script');
      script.textContent = `
        (function() {
          if (window.__INITIAL_STATE__) {
            window.postMessage({ type: 'BI_INITIAL_STATE', state: window.__INITIAL_STATE__ }, '*');
          }
        })();
      `;
      (doc.head || doc.documentElement).appendChild(script);

      setTimeout(() => {
        done(null);
        try { script.remove(); } catch (e) {}
      }, 3000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 2. URL / filename extraction                                       */
  /* ------------------------------------------------------------------ */

  function renditionOf(media, type) {
    return ((media && media.types) || []).find((t) => t.t === type) || null;
  }

  /**
   * URL for one rendition. A rendition with no transform path (`c`) means
   * baseUri already IS that file, which is how 'fullview' serves the original.
   *
   * prettyName must be percent-encoded inside the path: extra files in a
   * Scroll/Carousel deviation keep their upload names, so it can contain
   * spaces ("Kikansha Ningen.jpg") which otherwise produce an unfetchable URL.
   */
  function renditionUrl(media, type) {
    const t = renditionOf(media, type);
    if (!t) return null;
    const token = media.token && media.token[t.r >= 0 ? t.r : 0];
    if (!t.c) return token ? `${media.baseUri}?token=${token}` : (media.baseUri || null);
    const path = t.c.replace('<prettyName>', encodeURIComponent(media.prettyName || ''));
    return `${media.baseUri}${path}${token ? `?token=${token}` : ''}`;
  }

  /**
   * 'preview' is DeviantArt's own display rendition: re-encoded and capped at
   * roughly 0.8 megapixels, so it is a real disk saving. For artwork already
   * under that cap it has the same pixel dimensions as fullview and only the
   * lighter compression applies. Falls back to fullview when absent.
   */
  function pickImageType(media, preferPreview) {
    if (preferPreview && renditionOf(media, 'preview')) return 'preview';
    return renditionOf(media, 'fullview') ? 'fullview' : null;
  }

  /**
   * The filename a browser would suggest for the chosen rendition. The
   * rendition marker comes from the transform path, so it correctly reads
   * -pre for a downscaled preview and -fullview otherwise.
   */
  function browserSaveName(media, type) {
    const base = (media.baseUri || '').split('/').pop().split('?')[0];
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '.jpg';
    const pretty = media.prettyName || '';
    // Extra files keep their upload name, which is not a URL slug; those are
    // saved under the baseUri file name instead.
    if (!/^[a-z0-9_-]+$/i.test(pretty)) return base;
    const t = renditionOf(media, type);
    if (t && t.c) return t.c.split('/').pop().replace('<prettyName>', pretty);
    return `${pretty}-fullview${ext}`;
  }

  /**
   * Video deviations expose their renditions as media.types entries with
   * t === 'video' and an absolute, unsigned URL in `b`. media.baseUri only
   * points at the poster frame, so it must not be used for these.
   * Returns the highest-resolution rendition, or null for a still image.
   */
  function bestVideoRendition(media) {
    const renditions = ((media && media.types) || []).filter((t) => t.t === 'video' && t.b);
    if (!renditions.length) return null;
    return renditions
      .slice()
      .sort((a, b) => (b.h || 0) - (a.h || 0) || (b.f || 0) - (a.f || 0))[0];
  }

  /** One naming-pipeline item for a deviation's own media or an extra file. */
  function mediaItem(media, preferPreview) {
    if (!media) return null;
    const video = bestVideoRendition(media);
    if (video) {
      return { url: video.b, kind: 'video', width: video.w, height: video.h };
    }
    const type = pickImageType(media, preferPreview);
    if (!type) return null;
    const url = renditionUrl(media, type);
    if (!url) return null;
    const rendition = renditionOf(media, type) || {};
    return {
      url,
      kind: 'image',
      naturalName: browserSaveName(media, type),
      width: rendition.w,
      height: rendition.h,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Main extraction entry point                                     */
  /* ------------------------------------------------------------------ */

  // The page's own deviation id: deviationExtended normally holds exactly one
  // key (everything else in `deviation` is related art). If several are
  // present (e.g. SPA navigation), pick the one matching the numeric id at
  // the end of the page URL (.../art/Title-1356232657).
  function pickDeviationId(entities, href) {
    const ids = Object.keys(entities.deviationExtended);
    if (ids.length === 1) return ids[0];
    const match = href && String(href).match(/-(\d+)(?:[/?#]|$)/);
    if (match && ids.includes(match[1])) return match[1];
    return null;
  }

  function getDeviantArtImages(source, href, options = {}) {
    const preferPreview = options.preferPreview === true;
    const state = typeof source === 'string' ? extractInitialState(source) : source;
    const entities = state && state['@@entities'];
    if (!entities || !entities.deviationExtended || !entities.deviation) return null;

    const id = pickDeviationId(entities, href);
    if (!id) return null;

    const deviation = entities.deviation[id];
    const extended = entities.deviationExtended[id];
    if (!deviation || !extended) return null;

    const additional = extended.additionalMedia || [];
    const items = [];

    // Main media first, then the Scroll/Carousel extras in display order.
    const main = mediaItem(deviation.media, preferPreview);
    if (main) items.push(main);

    additional
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .forEach((entry) => {
        const item = mediaItem(entry.media, preferPreview);
        if (item) {
          if (entry.width) item.width = entry.width;
          if (entry.height) item.height = entry.height;
          items.push(item);
        }
      });

    if (!items.length) return null;

    const author = (entities.user && entities.user[deviation.author]
      && entities.user[deviation.author].username) || '';

    naming.buildDownloadNames(items, {
      author,
      pageUrl: deviation.url || href,
      title: deviation.title,
    });

    return {
      deviationId: id,
      title: deviation.title,
      author,
      images: items.map((item) => ({
        imageUrl: item.url,
        filename: item.filename,
        title: deviation.title,
        width: item.width || null,
        height: item.height || null,
      })),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Parser object                                                   */
  /* ------------------------------------------------------------------ */

  function createDeviantArtParser() {
    return {
      domain: 'deviantart.com',
      label: 'DeviantArt',
      isMainImageView(hostname, pathname) {
        return /^\/[^/]+\/art\/[^/]+$/i.test(pathname);
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      async extractImageUrls(doc, href, options = {}) {
        let state = getDeviantArtStateFromPage(doc);
        if (!state) {
          state = await getDeviantArtStateFromWindow(doc);
        }
        if (!state) {
          const el = doc.querySelector("img[data-hook='deviation_image']");
          const raw = el ? (el.currentSrc || el.src) : null;
          const resolved = helpers.resolveImageUrl ? helpers.resolveImageUrl(raw) : null;
          return resolved ? [{ imageUrl: resolved }] : [];
        }
        const result = getDeviantArtImages(state, href, options);
        return result ? result.images : [];
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5. Register with the shared registry                               */
  /* ------------------------------------------------------------------ */

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createDeviantArtParser());
  } else {
    global.createDeviantArtParser = createDeviantArtParser;
  }
})(typeof self !== 'undefined' ? self : this);
