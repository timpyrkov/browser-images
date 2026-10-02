// galleries.js
// Central registry of per-gallery page parsers. Each entry knows how to
// decide whether a URL is a single-image detail view and how to extract the
// main image URL from that page. Shared fallback utilities (Open Graph, largest
// visible image) live in content.js.
(function (global) {
  'use strict';

  const GALLERY_PARSERS = {};

  function resolveImageUrl(rawUrl) {
    if (!rawUrl) return null;
    if (typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
      return null;
    }
    try {
      const url = new URL(trimmed, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.searchParams.delete('w');
      url.searchParams.delete('h');
      url.searchParams.delete('q');
      url.searchParams.delete('fm');
      url.searchParams.delete('fit');
      url.searchParams.delete('auto');
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function parseIsoDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date) ? null : date.toISOString().split('T')[0];
  }

  function getPageDate(doc) {
    const metaSelectors = [
      "meta[property='article:published_time']",
      "meta[property='og:published_time']",
      "meta[property='og:updated_time']",
      "meta[name='publishedDate']",
      "meta[name='date']",
      "meta[itemprop='datePublished']",
      "meta[itemprop='dateModified']",
    ];
    for (const selector of metaSelectors) {
      const el = doc.querySelector(selector);
      const value = el?.getAttribute('content') || el?.getAttribute('value');
      const parsed = parseIsoDate(value);
      if (parsed) return parsed;
    }

    try {
      const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent || '{}');
        const candidates = [data.datePublished, data.dateModified, data.dateCreated];
        for (const value of candidates) {
          const parsed = parseIsoDate(value);
          if (parsed) return parsed;
        }
      }
    } catch (error) {
      // Ignore malformed JSON-LD.
    }

    return null;
  }

  // Rebuilt on every registration so the picker stays alphabetical no matter
  // what order the per-gallery modules happen to load in.
  function rebuildSupportedGalleries() {
    global.SUPPORTED_GALLERIES = Object.values(GALLERY_PARSERS)
      .map((g) => ({ key: g.domain, label: g.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // Exposed for per-gallery parser modules loaded after this file.
  function register(gallery) {
    GALLERY_PARSERS[gallery.domain] = gallery;
    rebuildSupportedGalleries();
  }

  /**
   * A tab belongs to a gallery when its hostname IS the registered domain or a
   * subdomain of it, so regional hosts like es.pinterest.com match. Substring
   * matching would also accept lookalikes such as notx.com.evil.net for x.com.
   */
  function matchesDomain(hostname, domain) {
    const host = String(hostname || '').toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }

  /** Registered domain key for a hostname, or null when none is registered. */
  function findGalleryDomain(hostname) {
    return Object.keys(GALLERY_PARSERS).find((domain) => matchesDomain(hostname, domain)) || null;
  }

  global.registerGallery = register;
  global.findGalleryDomain = findGalleryDomain;
  global.GALLERY_HELPERS = {
    getPageDate,
    resolveImageUrl,
    matchesDomain,
    findGalleryDomain,
  };

  // ArtStation, DeviantArt and Pinterest are registered by their dedicated
  // parser modules in galleries/, loaded after this file.

  global.GALLERY_PARSERS = GALLERY_PARSERS;
  rebuildSupportedGalleries();
})(typeof self !== 'undefined' ? self : this);
