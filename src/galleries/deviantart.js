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

  /**
   * Why a deviation cannot be downloaded, or null when it can be.
   *
   * Subscription-locked deviations carry tierAccess === 'locked' and the field
   * is simply absent otherwise. Their media still contains blurred renditions,
   * so this has to be checked BEFORE building items or we would happily save
   * the blur. Deliberately not using isDownloadable: it is false on plenty of
   * perfectly accessible artwork (it only reflects the download button).
   */
  function unavailableReason(deviation) {
    if (!deviation) return 'missing';
    const tier = deviation.tierAccess || deviation.tier_access;
    if (tier && String(tier).toLowerCase() === 'locked') return 'subscription locked';
    const premium = deviation.premiumFolderData || deviation.premium_folder_data;
    if (premium && premium.hasAccess === false) return 'premium folder';
    if (deviation.isBlocked) return 'blocked';
    if ((deviation.blockReasons || []).length) return 'blocked';
    if (deviation.isDeleted) return 'deleted';
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

    const blocked = unavailableReason(deviation);
    if (blocked) {
      return { deviationId: id, title: deviation.title, images: [], unavailable: blocked };
    }

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

    // Literature, journals and status posts land here: nothing to download,
    // but not an error either.
    if (!items.length) {
      return { deviationId: id, title: deviation.title, images: [], unavailable: 'no downloadable media' };
    }

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
      // Used for the max-date filter when a deviation is fetched directly and
      // there is no document to read meta tags from.
      pageDate: deviation.publishedTime
        ? new Date(deviation.publishedTime).toISOString().split('T')[0]
        : null,
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
  /* 3b. Gallery / search index pages                                    */
  /* ------------------------------------------------------------------ */

  // Index pages that list many deviations. The first group, when present,
  // is the owning user, which scopes link collection to their work and keeps
  // "more like this" suggestions from other artists out.
  const OWNED_INDEX = /^\/([^/]+)\/(?:gallery|favourites)(?:\/|$)/i;
  const OPEN_INDEX = /^\/(?:search|tag)(?:\/|$)/i;

  function indexOwner(pathname) {
    const match = OWNED_INDEX.exec(pathname || '');
    return match ? match[1].toLowerCase() : null;
  }

  function isIndexView(pathname) {
    return OWNED_INDEX.test(pathname || '') || OPEN_INDEX.test(pathname || '');
  }

  /**
   * The active search term, if the index page is filtered.
   *
   * This matters because DeviantArt applies `?q=` CLIENT-side: the server still
   * ships the folder's newest deviations in __INITIAL_STATE__, so on
   * /quickhoof/gallery?q=underwater the embedded stream lists Blindfold09,
   * Bib26 and friends while the grid actually shows the underwater results.
   * Reading the state on such a page therefore injects wrong deviations.
   */
  function indexSearchQuery(href, state) {
    try {
      const q = new URL(href, 'https://www.deviantart.com').searchParams.get('q');
      if (q && q.trim()) return q.trim();
    } catch (error) { /* fall through to the state */ }
    const section = state && state.gallectionSection;
    const fromState = section && (section.searchQuery || section.searchInputValue);
    return fromState && String(fromState).trim() ? String(fromState).trim() : null;
  }

  /**
   * How the index page is ordered ("newest", "oldest", "popular", ...).
   * The URL wins when it carries ?order=; otherwise the page state says what
   * the UI is actually showing, and DeviantArt defaults galleries to newest.
   */
  function indexSortOrder(href, state) {
    try {
      const fromUrl = new URL(href, 'https://www.deviantart.com').searchParams.get('order');
      if (fromUrl && fromUrl.trim()) return fromUrl.trim().toLowerCase();
    } catch (error) { /* fall through to the state */ }
    const section = state && state.gallectionSection;
    if (section && section.sortOrder) return String(section.sortOrder).toLowerCase();
    const streams = (state && state['@@streams']) || {};
    const key = Object.keys(streams).find((k) => k.startsWith('folder-deviations'));
    const effective = key && streams[key].streamParams && streams[key].streamParams.effectiveOrder;
    return effective ? String(effective).toLowerCase() : null;
  }

  /** Only an unfiltered folder listing has a trustworthy embedded stream. */
  function stateIsTrustworthy(href, state) {
    if (indexSearchQuery(href, state)) return false;
    try {
      return OWNED_INDEX.test(new URL(href, 'https://www.deviantart.com').pathname);
    } catch (error) {
      return false;
    }
  }

  /** Absolute deviation URL, or null when `href` is not one. */
  function deviationHref(href, owner) {
    const match = /^https?:\/\/(?:www\.)?deviantart\.com\/([^/]+)\/art\/[A-Za-z0-9-]+-\d+$/.exec(String(href || ''));
    if (!match) return null;
    if (owner && match[1].toLowerCase() !== owner) return null;
    return href;
  }

  /**
   * Deviation links on an index page, taken from the embedded state first
   * (authoritative and in display order) and topped up from the DOM, which is
   * where anything loaded after the initial render appears.
   */
  function collectDeviationLinks(doc, href, sink) {
    const owner = indexOwner(new URL(href, 'https://www.deviantart.com').pathname);
    // Accumulates across calls: the grid is virtualised, so each read only ever
    // sees the current window and anything scrolled past is already gone.
    const links = sink instanceof Set ? sink : new Set();
    const add = (candidate) => {
      const url = deviationHref(candidate, owner);
      if (url) links.add(url);
    };

    const state = getDeviantArtStateFromPage(doc);
    const entities = state && state['@@entities'];
    if (entities && entities.deviation && stateIsTrustworthy(href, state)) {
      const streams = state['@@streams'] || {};
      Object.keys(streams).forEach((key) => {
        const items = streams[key] && streams[key].items;
        if (!Array.isArray(items)) return;
        items.forEach((id) => {
          const deviation = entities.deviation[id];
          if (deviation && deviation.url) add(deviation.url);
        });
      });
    }

    Array.from(doc.querySelectorAll ? doc.querySelectorAll('a[href*="/art/"]') : [])
      .forEach((anchor) => add(anchor.href));

    return links;
  }

  /**
   * How many deviations the page says the current folder holds. The state
   * carries it (folder -1 is "All"), which turns an open-ended "scroll until
   * it seems finished" walk into one with a known finish line — the difference
   * between collecting 2545 links and stopping early at 384.
   */
  function expectedIndexTotal(doc, href) {
    try {
      const state = getDeviantArtStateFromPage(doc);
      if (!state) return null;
      const section = state.gallectionSection || {};
      // A filtered view has no published total: the folder sizes describe the
      // whole folder, not the matches, so any target read here would be wrong.
      if (indexSearchQuery(href, state)) return null;
      const folders = (state['@@entities'] || {}).galleryFolder || {};
      const wanted = section.selectedSubfolderId != null && section.selectedSubfolderId !== -1
        ? section.selectedSubfolderId
        : section.selectedFolderId;
      const folder = Object.values(folders).find((f) => f && f.folderId === wanted);
      return folder && Number.isFinite(folder.size) ? folder.size : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * How many matches a filtered view reports, from its own results header
   * ("Results for 'military' in All — About 499 results").
   *
   * It is rendered client-side, so it exists only in the live DOM, and both the
   * wording and the class names are unusable as anchors (localised and
   * obfuscated respectively). The term itself is the stable anchor: find the
   * smallest element quoting it, remove the term, and read the number left
   * over. Note DeviantArt says "About", so treat the figure as approximate.
   */
  function searchResultTotal(doc, term) {
    if (!term || !doc.querySelectorAll) return null;
    // Anchor on the QUOTED term. Merely containing the word is not enough: a
    // deviation titled "UnderwaterPeril25" matches a search for "underwater"
    // and would hand back 25. Only the header quotes the term back at you.
    const QUOTES = '["\'\u2018\u2019\u201c\u201d\u00ab\u00bb]';
    const quoted = new RegExp(`${QUOTES}\\s*${escapeRegExp(String(term))}\\s*${QUOTES}`, 'i');
    let best = null;
    const nodes = doc.querySelectorAll('span, h1, h2, h3, p, div');
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 200) continue;
      if (!quoted.test(text)) continue;
      // Drop the quoted term first: it may itself contain digits (q=2024).
      const cleaned = text.replace(quoted, ' ');
      const match = /(\d[\d.,\u00a0\u202f ]*)\s*([KM])?/i.exec(cleaned);
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
      // Prefer the tightest wrapper, which is the results header itself.
      if (!best || text.length < best.length) best = { value: Math.round(value), length: text.length };
    }
    return best ? best.value : null;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Candidate controls that advance the index page to its next batch. */
  function nextPageButtons(doc) {
    return Array.from(doc.querySelectorAll ? doc.querySelectorAll('button, a') : [])
      .filter((el) => /^(next|more)$/i.test((el.getAttribute('aria-label') || '').trim()))
      .filter((el) => !el.disabled);
  }

  /**
   * Collect every deviation link on an index page, optionally driving the
   * page's own pagination.
   *
   * Two DeviantArt behaviours shape this. First, the grid is VIRTUALISED:
   * scrolling past a thumbnail removes it from the DOM again, so links must be
   * accumulated as they pass by and the page must be walked in viewport-sized
   * steps — jumping straight to the bottom skips whole windows that are never
   * rendered while we are looking. Second, how more items arrive depends on the
   * viewer: signed in the grid lazy-loads on scroll, signed out it offers a
   * Next control instead.
   *
   * Stops once the page can no longer be scrolled further AND several
   * consecutive rounds have added nothing, so a slow lazy-load or a stretch of
   * text deviations does not end the walk early.
   */
  async function collectAllDeviationLinks(doc, href, options = {}) {
    const paginate = options.paginate !== false;
    // Walking in viewport steps needs far more rounds than jumping to the
    // bottom did: budget for a very large gallery rather than truncating it.
    const maxRounds = Math.max(1, options.maxRounds || 4000);
    const settleMs = Math.max(100, options.settleMs || 600);
    // A stalled round usually means a slow lazy-load, not the end of the
    // gallery, so give up only after several escalating waits. How long to
    // persist is decided below, once we know whether a total is available.
    const view = options.view || (typeof window !== 'undefined' ? window : null);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Walking a big gallery takes minutes, so report as we go and allow the
    // user to stop; without either, the sidebar just sits there looking hung.
    const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const stopped = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;

    const links = new Set();
    // Exact: the folder's own size. Reaching it means the walk is finished.
    const target = expectedIndexTotal(doc, href);
    // Approximate: a search header's "About N results". Good enough to show as
    // a denominator and to know roughly when to relax, but NOT to stop on --
    // "About 2.5K" could be 2542, and stopping at 2500 would lose the tail.
    const softTarget = target ? null
      : searchResultTotal(doc, indexSearchQuery(href, getDeviantArtStateFromPage(doc)));

    // Until we are in the expected range, a stalled round is far more likely to
    // be a throttled lazy-load than the end of the results, so wait much longer
    // before believing it. Once the count is reached, relax back.
    const patientRounds = Math.max(1, options.idleRounds || 12);
    const quickRounds = Math.max(1, options.idleRounds || 6);
    const patientMs = Math.max(settleMs, options.maxPatienceMs || 20000);
    const quickMs = Math.max(settleMs, options.maxPatienceMs || 10000);
    const reachedExpected = () => softTarget != null && links.size >= softTarget;
    const idleLimitNow = () => (target || reachedExpected() ? quickRounds : patientRounds);
    const patienceCapNow = () => (target || reachedExpected() ? quickMs : patientMs);

    collectDeviationLinks(doc, href, links);
    report(links.size, target || softTarget);
    if (!paginate) return Array.from(links);

    // Lazy-loading is driven by what the page considers visible, and browsers
    // throttle timers in hidden tabs, so a backgrounded gallery can simply
    // stop feeding new items. Worth saying out loud when results look short.
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) {
      console.warn('[Content] The gallery tab is in the background; '
        + 'lazy-loading may be throttled. Keep it visible for a full harvest.');
    }

    const startY = (view && view.scrollY) || 0;
    let idle = 0;
    let patience = settleMs;

    for (let round = 0; round < maxRounds && idle < idleLimitNow(); round++) {
      if (stopped()) break;
      const before = links.size;
      let moved = false;

      if (view && typeof view.scrollTo === 'function') {
        const from = view.scrollY || 0;
        const step = Math.max(400, Math.floor((view.innerHeight || 800) * 0.8));
        view.scrollTo(0, from + step);
        await wait(settleMs);
        moved = (view.scrollY || 0) !== from;
        collectDeviationLinks(doc, href, links);
      }

      if (links.size === before && !moved) {
        for (const button of nextPageButtons(doc)) {
          try { button.click(); } catch (error) { continue; }
          await wait(settleMs);
          collectDeviationLinks(doc, href, links);
          if (links.size > before) break;
        }
      }

      if (links.size > before || moved) {
        idle = 0;
        patience = settleMs;   // making progress again
      } else {
        // Nothing new and nowhere left to scroll. That usually means the next
        // batch is still in flight rather than that the gallery has ended, so
        // wait longer each time before believing it is over.
        idle++;
        await wait(patience);
        collectDeviationLinks(doc, href, links);
        if (links.size > before) {
          idle = 0;
          patience = settleMs;
        } else {
          console.log(`[Content] No new links for ${idle} round(s) at ${links.size} `
            + `collected; waiting ${Math.round(patience / 1000)}s before giving up.`);
          patience = Math.min(patience * 2, patienceCapNow());
        }
      }

      report(links.size, target || softTarget);
      if (target && links.size >= target) break;   // reached the exact total
    }

    if (target && links.size < target) {
      console.warn(`[Content] Collected ${links.size} of ${target} deviations; `
        + 'the gallery may still have been loading.');
    } else if (softTarget != null) {
      const how = links.size >= softTarget ? 'met' : 'SHORT OF';
      console.log(`[Content] Collected ${links.size} links, ${how} the reported `
        + `~${softTarget} results${hidden ? ' (tab was hidden)' : ''}.`);
    } else if (!target) {
      console.log(`[Content] Collected ${links.size} links with no published total`
        + `${hidden ? ' (tab was hidden)' : ''}.`);
    }

    // Leave the user's tab where we found it.
    if (view && typeof view.scrollTo === 'function') view.scrollTo(0, startY);
    return Array.from(links);
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
      isIndexView(hostname, pathname) {
        return isIndexView(pathname);
      },
      async extractIndexLinks(doc, href, options = {}) {
        return collectAllDeviationLinks(doc, href, options);
      },
      expectedIndexTotal(doc, href) {
        return expectedIndexTotal(doc, href);
      },
      /** The `?q=` term filtering this index page, or null. */
      indexSearchTerm(doc, href) {
        return indexSearchQuery(href, getDeviantArtStateFromPage(doc));
      },
      /** "newest" / "oldest" / "popular" / null. */
      indexSortOrder(doc, href) {
        return indexSortOrder(href, getDeviantArtStateFromPage(doc));
      },
      /**
       * Parse a deviation straight from fetched HTML. Service workers have no
       * DOMParser, but the state is read out of the raw text anyway, so this
       * works without ever opening a tab.
       */
      parseDeviationHtml(html, href, options = {}) {
        try {
          const result = getDeviantArtImages(html, href, options);
          if (!result) return null;
          return {
            images: result.images,
            title: result.title,
            pageDate: result.pageDate,
            unavailable: result.unavailable || null,
          };
        } catch (error) {
          return null;
        }
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
