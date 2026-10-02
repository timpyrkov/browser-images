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
    const m = String(pathname || '').match(/^\/([A-Za-z0-9_-]+)\/?$/);
    return m && !RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
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
    return String(url || '').replace('/large/', '/4k/');
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

  function basename(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'video.mp4';
    } catch (error) {
      return 'video.mp4';
    }
  }

  /**
   * Media for one project JSON. Images resolve immediately; video clips need
   * their player page, fetched through `getText`.
   */
  async function projectMedia(project, getTextFn) {
    const title = project.title || '';
    const username = (project.user && project.user.username) || 'artstation';
    const media = [];
    for (const asset of project.assets || []) {
      if (asset.asset_type === 'image' && asset.has_image && asset.image_url) {
        media.push({ imageUrl: fullSizeImageUrl(asset.image_url), kind: 'image', title });
      } else if (asset.asset_type === 'video_clip') {
        const embed = embedUrlFromPlayer(asset.player_embedded);
        if (!embed) continue;
        try {
          const src = bestClipSource(await getTextFn(embed));
          // Clip files have generic names (a.mp4), so prefix artist and asset.
          if (src) {
            media.push({ imageUrl: src, kind: 'video', title, filename: `${username}_${asset.id}_${basename(src)}` });
          }
        } catch (error) {
          console.warn('[ArtStation] Could not read video clip', embed, error.message);
        }
      } else if (asset.asset_type !== 'cover') {
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
      isMainImageView(hostname, pathname) {
        return isArtStationHost(hostname) && /\/artwork\/[A-Za-z0-9]+/.test(pathname || '');
      },
      isIndexView(hostname, pathname) {
        return isArtStationHost(hostname) && !!profileNameFromPath(pathname);
      },
      extractPageDate(doc) {
        return helpers.getPageDate ? helpers.getPageDate(doc) : null;
      },

      async extractImageUrls(doc, href, options = {}) {
        const hash = projectHashFromUrl(href);
        if (!hash) return [];
        try {
          const origin = new URL(href).origin;
          const project = await getJson(`${origin}/projects/${hash}.json`, options);
          const media = await projectMedia(project, (url) => getText(url, options));
          const pageDate = (project.published_at || '').slice(0, 10) || null;
          if (media.length) return media.map((item) => ({ ...item, pageDate }));
        } catch (error) {
          console.warn('[ArtStation] Project JSON unavailable, falling back to og:image:', error.message);
        }
        const og = doc.querySelector("meta[property='og:image']");
        const ogUrl = helpers.resolveImageUrl ? helpers.resolveImageUrl(og && og.getAttribute('content')) : null;
        return ogUrl ? [{ imageUrl: ogUrl, kind: 'image' }] : [];
      },

      /**
       * Walk the artist's portfolio and return every project's media directly
       * (not links): the projects are fetched here, inside the page, because
       * a background fetch would not carry the Cloudflare clearance.
       */
      async extractIndexLinks(doc, href, options = {}) {
        const url = new URL(href);
        const username = profileNameFromPath(url.pathname);
        if (!username) return [];
        const paginate = options.paginate !== false;
        const maxDate = options.maxDate || '';
        const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const stopped = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
        const fetchText = (u) => getText(u, options);
        const images = [];
        let done = 0;
        let total = 0;

        for (let page = 1; !stopped(); page++) {
          let list;
          try {
            list = await getJson(`${url.origin}/users/${username}/projects.json?page=${page}`, options);
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
            if (maxDate && published && published < maxDate) {
              report(done, total);
              continue;
            }
            try {
              await sleep(FETCH_GAP_MS);
              const project = await getJson(`${url.origin}/projects/${summary.hash_id}.json`, options);
              const media = await projectMedia(project, fetchText);
              images.push(...media.map((item) => ({ ...item, pageDate: published || null })));
            } catch (error) {
              console.warn(`[ArtStation] Skipping project ${summary.hash_id}:`, error.message);
            }
            report(done, total);
          }
          // Newest first: once a page ends before the cutoff, later pages are older still.
          const last = (projects[projects.length - 1].published_at || '').slice(0, 10);
          if (!paginate || (maxDate && last && last < maxDate) || done >= total) break;
        }
        return { images };
      },
    };
  }

  if (global && typeof global.registerGallery === 'function') {
    global.registerGallery(createArtStationParser());
  }
  global.ARTSTATION_INTERNALS = { projectMedia, bestClipSource, fullSizeImageUrl, profileNameFromPath };
})(typeof self !== 'undefined' ? self : this);
