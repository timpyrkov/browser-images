// galleries/artstation.js
// ArtStation-specific parser for the Browser Images extension.
//
// ArtStation publishes every artwork as JSON at /projects/{hash}.json, and an
// artist's portfolio at /users/{name}/projects.json?page=N (50 per page,
// newest first, with total_count). Both sit behind Cloudflare, which rejects
// requests from outside a real browser session, so they are fetched from the
// content script, i.e. from inside the user's own ArtStation tab.
//
// Asset types in a project:
//   image      -> image_url is the /large/ rendition, capped at 1920px; the
//                 same path under /4k/ is the full image (/original/ is 403).
//   video_clip -> ArtStation-hosted video. player_embedded holds an <iframe>
//                 whose page lists <source> tags; the widest media query is
//                 the largest file.
//   cover      -> the square gallery thumbnail; not part of the artwork.
//   video etc. -> third-party embeds (YouTube, ...), not downloadable here.
(function (global) {
  'use strict';

  const helpers = (global && global.GALLERY_HELPERS) || {};

  // First path segments that are site sections, not artist names.
  const RESERVED = new Set(['artwork', 'artworks', 'search', 'learning', 'marketplace', 'jobs', 'blogs',
    'challenges', 'contests', 'prints', 'channels', 'about', 'users', 'projects', 'api', 'login',
    'signup', 'settings', 'messages', 'notifications', 'community', 'studios', 'guides', 'pro',
    'subscribe', 'shop', 'terms', 'privacy', 'magazine', 'events']);

  // Items the last scan found but cannot download (videos embedded from
  // YouTube, Vimeo, ...), so the row can read "Partial (5/8)".
  let lastUnavailable = 0;

  const FETCH_GAP_MS = 400;          // pause between JSON requests
  const MAX_ATTEMPTS = 3;            // per request, on 403/429
  const BACKOFF_BASE_MS = 5000;      // 5 s, 10 s, ...

  function isArtStationHost(hostname) {
    return /(^|\.)artstation\.com$/i.test(hostname || '');
  }

  function projectHashFromUrl(href) {
    const m = String(href || '').match(/\/artwork\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function profileNameFromPath(pathname) {
    const portfolio = portfolioFromPath(pathname);
    return portfolio ? portfolio.username : null;
  }

  /**
   * An artist's portfolio (/{name}, /{name}/albums/all) or one of its albums
   * (/{name}/albums/{id}). Both list projects through the same endpoint; an
   * album only adds album_id to it.
   */
  function portfolioFromPath(pathname) {
    const m = String(pathname || '').match(/^\/([A-Za-z0-9_-]+)(?:\/albums\/(\d+|all))?\/?$/);
    if (!m || RESERVED.has(m[1].toLowerCase())) return null;
    return { username: m[1], albumId: m[2] && m[2] !== 'all' ? m[2] : null };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Firefox content scripts expose content.fetch, which sends the request as
  // the page itself (same cookies, same Cloudflare clearance).
  function pageFetch() {
    /* global content */
    if (typeof content !== 'undefined' && content && typeof content.fetch === 'function') {
      return content.fetch.bind(content);
    }
    if (global && typeof global.__BI_PAGE_FETCH__ === 'function') {
      return global.__BI_PAGE_FETCH__;
    }
    return fetch.bind(global);
  }

  /** GET with backoff on 403/429. Returns the Response body via `read`. */
  async function getWithBackoff(url, read, options) {
    const doFetch = options.fetch || pageFetch();
    for (let attempt = 1; ; attempt++) {
      const response = await doFetch(url, { credentials: 'include' });
      if (response.ok) return read(response);
      const pushBack = response.status === 403 || response.status === 429;
      if (!pushBack || attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status} for ${url}`);
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    }
  }

  const getJson = (url, options) => getWithBackoff(url, (r) => r.json(), options);
  const getText = (url, options) => getWithBackoff(url, (r) => r.text(), options);

  function fullSizeImageUrl(url) {
    return String(url || '').replace(/\/(?:small|medium|large)\//, '/4k/');
  }

  /** https URL on ArtStation's own hosts (www, cdn, cdna, cdnb, ...). */
  function isArtStationUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && isArtStationHost(parsed.hostname);
    } catch (error) {
      return false;
    }
  }

  function isArtworkImageUrl(url) {
    return isArtStationUrl(url) && new URL(url).pathname.includes('/p/assets/images/images/');
  }

  /** ArtStation-hosted clip file, e.g. https://cdn.artstation.com/p/video_sources/.../clip.mp4 */
  function isClipVideoUrl(url) {
    return isArtStationUrl(url) && /\.mp4$/i.test(new URL(url).pathname);
  }

  /** Video clip player page, served from ArtStation itself (www.artstation.com/api/v2/animation/...). */
  function isClipPlayerUrl(url) {
    return isArtStationUrl(url) && new URL(url).pathname.startsWith('/api/v2/animation/video_clips/');
  }

  /**
   * Last-resort extraction from the live project DOM. ArtStation renders each
   * project item inside <project-asset>; keeping that scope avoids profile
   * avatars, ads and related-project thumbnails. Generic Open Graph assets
   * such as share-explore.jpg never match the artwork path above.
   */
  function renderedProjectMedia(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const media = [];
    const seen = new Set();
    for (const asset of doc.querySelectorAll('project-asset')) {
      for (const img of asset.querySelectorAll ? asset.querySelectorAll('img') : []) {
        const raw = img.currentSrc || img.src || img.getAttribute?.('src');
        if (!isArtworkImageUrl(raw)) continue;
        const url = fullSizeImageUrl(raw);
        if (seen.has(url)) continue;
        seen.add(url);
        media.push({ imageUrl: url, kind: 'image', title: img.alt || '' });
      }
      for (const source of asset.querySelectorAll ? asset.querySelectorAll('video source[src], video[src]') : []) {
        const url = source.currentSrc || source.src || source.getAttribute?.('src');
        if (!url || !isClipVideoUrl(url) || seen.has(url)) continue;
        seen.add(url);
        media.push({ imageUrl: url, kind: 'video', title: source.title || '' });
      }
    }
    return media;
  }

  function embedUrlFromPlayer(playerHtml) {
    const m = String(playerHtml || '').match(/src=['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  }

  /** Largest video in a video_clip player page: the widest min-width query. */
  function bestClipSource(html) {
    let best = null;
    const re = /<source\b[^>]*>/gi;
    let tag;
    while ((tag = re.exec(String(html || ''))) !== null) {
      const src = (tag[0].match(/\bsrc=["']([^"']+)["']/) || [])[1];
      if (!src) continue;
      const width = parseInt((tag[0].match(/min-width:\s*(\d+)px/) || [])[1] || '0', 10);
      if (!best || width > best.width) best = { src, width };
    }
    return best ? best.src : null;
  }

  function sanitizeName(value) {
    const naming = global && global.MEDIA_NAMING;
    const clean = naming ? naming.sanitizeFilename(value) : String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
    return clean || 'artstation';
  }

  /** Clip file name, sanitized: a decoded %2F must not become a folder. */
  function basename(url) {
    let name = '';
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch (error) { /* fall through to the default */ }
    const clean = sanitizeName(name);
    return /\.mp4$/i.test(clean) ? clean : 'video.mp4';
  }

  /**
   * Media for one project JSON. Images resolve immediately; video clips need
   * their player page, fetched through `getText`.
   */
  async function projectMedia(project, getTextFn) {
    const title = project.title || '';
    // The artist, appended to every file name as "_by_{author}" (content.js).
    const author = (project.user && project.user.username) || '';
    const media = [];
    // Videos embedded from other sites (YouTube, Vimeo, ...) are not hosted by
    // ArtStation and are not downloaded; counted so the row can say why.
    media.externalVideos = 0;
    for (const asset of project.assets || []) {
      if (asset.asset_type === 'image' && asset.has_image && isArtStationUrl(asset.image_url)) {
        media.push({ imageUrl: fullSizeImageUrl(asset.image_url), kind: 'image', title, author });
      } else if (asset.asset_type === 'video_clip') {
        const embed = embedUrlFromPlayer(asset.player_embedded);
        if (!embed || !isClipPlayerUrl(embed)) continue;
        try {
          const found = bestClipSource(await getTextFn(embed));
          const src = found ? new URL(found, embed).href : null;
          // Clip files have generic names (a.mp4), so prefix the asset id;
          // the artist follows as "_by_{author}".
          if (src && isClipVideoUrl(src)) {
            const prefix = sanitizeName(String(asset.id || 'clip'));
            media.push({ imageUrl: src, kind: 'video', title, author, filename: `${prefix}_${basename(src)}` });
          }
        } catch (error) {
          console.warn('[ArtStation] Could not read video clip', embed, error.message);
        }
      } else if (asset.asset_type !== 'cover') {
        if (asset.has_embedded_player || asset.asset_type === 'video') media.externalVideos++;
        console.log(`[ArtStation] Skipping ${asset.asset_type} asset ${asset.id} (not hosted by ArtStation)`);
      }
    }
    return media;
  }

  function createArtStationParser() {
    return {
      domain: 'artstation.com',
      label: 'ArtStation',
      // Same pacing as Pinterest: one file at a time, backing off when the
      // CDN pushes back.
      downloadPolicy: { awaitCompletion: true, minDelaySeconds: 1 },
      // Its og:image can be a generic share-explore.jpg; never let content.js
      // re-apply that generic fallback after this parser rejects it.
      disableGenericFallback: true,
      isMainImageView(hostname, pathname) {
        return isArtStationHost(hostname) && /\/artwork\/[A-Za-z0-9]+/.test(pathname || '');
      },
      isIndexView(hostname, pathname) {
        return isArtStationHost(hostname) && !!profileNameFromPath(pathname);
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },
      /** Items the last extractImageUrls() found but could not download. */
      unavailableCount() {
        return lastUnavailable;
      },

      async extractImageUrls(doc, href, options = {}) {
        const hash = projectHashFromUrl(href);
        if (!hash) return [];
        lastUnavailable = 0;
        try {
          const origin = new URL(href).origin;
          const project = await getJson(`${origin}/projects/${hash}.json`, options);
          const media = await projectMedia(project, (url) => getText(url, options));
          const pageDate = (project.published_at || '').slice(0, 10) || null;
          lastUnavailable = media.externalVideos;
          if (media.length) return media.map((item) => ({ ...item, pageDate }));
          // The project data is authoritative: only embedded videos, so do not
          // guess from the page; the row reads "Partial (0/n)".
          if (media.externalVideos) return [];
        } catch (error) {
          console.warn('[ArtStation] Project JSON unavailable; using rendered project assets:', error.message);
        }
        const rendered = renderedProjectMedia(doc);
        if (rendered.length) return rendered;
        // Some server-rendered pages expose the real artwork only as og:image.
        // Accept it only when it has ArtStation's actual artwork-asset path.
        const og = doc.querySelector("meta[property='og:image']");
        const ogUrl = helpers.resolveImageUrl ? helpers.resolveImageUrl(og && og.getAttribute('content')) : null;
        return ogUrl && isArtworkImageUrl(ogUrl) ? [{ imageUrl: fullSizeImageUrl(ogUrl), kind: 'image' }] : [];
      },

      /**
       * Walk the artist's portfolio, or one album of it, and return every
       * project's media directly (not links): the projects are fetched here,
       * inside the page, because a background fetch would not carry the
       * Cloudflare clearance.
       */
      async extractIndexLinks(doc, href, options = {}) {
        const url = new URL(href);
        const portfolio = portfolioFromPath(url.pathname);
        if (!portfolio) return [];
        const { username, albumId } = portfolio;
        const albumParam = albumId ? `&album_id=${albumId}` : '';
        const paginate = options.paginate !== false;
        const maxDate = options.maxDate || '';
        const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const stopped = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
        const fetchText = (u) => getText(u, options);
        const images = [];
        let unavailable = 0;
        let done = 0;
        let total = 0;

        for (let page = 1; !stopped(); page++) {
          let list;
          try {
            list = await getJson(`${url.origin}/users/${username}/projects.json?page=${page}${albumParam}`, options);
          } catch (error) {
            // Keep what was collected; a later page failing should not void it.
            console.warn(`[ArtStation] Portfolio page ${page} unavailable:`, error.message);
            break;
          }
          const projects = list.data || [];
          total = list.total_count || total;
          if (!projects.length) break;
          for (const summary of projects) {
            if (stopped()) break;
            done++;
            const published = (summary.published_at || '').slice(0, 10);
            if (!/^[A-Za-z0-9]+$/.test(String(summary.hash_id || ''))) {
              report(done, total);
              continue;
            }
            if (maxDate && published && published < maxDate) {
              report(done, total);
              continue;
            }
            try {
              await sleep(FETCH_GAP_MS);
              const project = await getJson(`${url.origin}/projects/${summary.hash_id}.json`, options);
              const media = await projectMedia(project, fetchText);
              unavailable += media.externalVideos;
              images.push(...media.map((item) => ({ ...item, pageDate: published || null })));
            } catch (error) {
              console.warn(`[ArtStation] Skipping project ${summary.hash_id}:`, error.message);
            }
            report(done, total);
          }
          // Newest first: once a page ends before the cutoff, later pages are older still.
          const last = (projects[projects.length - 1].published_at || '').slice(0, 10);
          // Albums follow the artist's own arrangement, not dates, so they are
          // always walked to the end; old projects are still skipped above.
          const pastCutoff = !albumId && maxDate && last && last < maxDate;
          if (!paginate || pastCutoff || done >= total) break;
        }
        return { images, unavailable };
      },
    };
  }

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createArtStationParser());
  }
  global.ARTSTATION_INTERNALS = {
    projectMedia, bestClipSource, fullSizeImageUrl, profileNameFromPath, portfolioFromPath, isArtworkImageUrl, renderedProjectMedia,
    isClipVideoUrl, isClipPlayerUrl,
  };
})(typeof self !== 'undefined' ? self : this);
