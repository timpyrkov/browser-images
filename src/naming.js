// naming.js
// Download filename policy for gallery media.
//
// DeviantArt names its own artwork files
//
//     {slug}_by_{author}_{hash}[-{marker}].{ext}
//
// where the hash is a 7-8 character base-36 deviation id ("dmfgems") and the
// optional marker names the rendition. Verified against the real page state:
// every one of 62 hashes was exactly 7 characters, and the download-worthy
// markers are -pre, -fullview and -2x (they also chain, as in -pre-2x). Those
// three are why a complete stem ends in "e", "w" or "x".
//
// The author is always taken from the page URL rather than from the file name:
// author names may contain dashes and underscores, both of which collapse to
// underscores in the file name, so the name alone cannot be split reliably
// (titles containing "_by_" make it ambiguous too).
//
// Rules implemented here:
//   (a) one image  - keep DeviantArt's own name when it matches the pattern,
//                    otherwise synthesise {slug}_by_{author}_{hash}-pre from
//                    the page URL.
//   (b) one video  - prefix the natural file name with {author}_.
//   (c) N images   - (a) for the first, then the same stem with its last
//                    character swapped for the next sibling code. After a
//                    "-pre" ending the codes also depend on the image count.
//   (d) N videos   - (b) for each.
//   (e) mixed      - (a)+(c) across the images, (d) across the videos.
(function (global) {
  'use strict';

  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  const DIGITS = '0123456789';

  const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv']);

  /** Split "a.b.c.mp4" into { stem: "a.b.c", ext: ".mp4" }. */
  function splitExtension(name) {
    const dot = String(name || '').lastIndexOf('.');
    if (dot <= 0) return { stem: String(name || ''), ext: '' };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }

  /** DeviantArt's slug convention: one underscore per non-alphanumeric char. */
  function slugify(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  function sanitizeFilename(name) {
    if (!name) return null;
    return String(name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{3,}/g, '__')
      .replace(/^[._]+/, '')
      .replace(/[.]+$/, '');
  }

  // Rendition markers that may follow the hash. DeviantArt uses -pre and
  // -fullview plus a family of sized thumbnails (-150, -200h, -250t, -300w,
  // -375w, -414w, -92s, -125s), and any of them may carry a -2x retina suffix
  // — a real saved file can be named ..._dh7pkdy-414w-2x.jpg. The digit form
  // stays generic so sizes DeviantArt adds later still parse.
  const MARKER = '(?:pre|fullview|\\d{2,4}[hwts]?)';
  const MARKER_CHAIN = `(?:-${MARKER})?(?:-2x)?`;

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Parse {slug}_by_{author}_{hash}[-marker...].
   *
   * When the author is known it anchors the pattern, which is the only way to
   * split names whose title itself contains "_by_"
   * (xena_and_gabrielle_on_the_road_by_whisk_by_lhj0323_dkiuo19) or whose
   * author contains underscores (kanesha_andrews). Without one, a greedy
   * fallback treats the LAST "_by_" as the separator.
   */
  function parseArtworkStem(stem, author) {
    const text = String(stem || '');
    if (author) {
      const anchored = new RegExp(
        `^(.+)_by_${escapeRegExp(author)}_([a-z0-9]{7,8})(${MARKER_CHAIN})$`, 'i');
      const match = anchored.exec(text);
      if (match) return { slug: match[1], author, hash: match[2], marker: match[3] || '' };
    }
    const match = new RegExp(`^(.+)_by_(.+)_([a-z0-9]{7,8})(${MARKER_CHAIN})$`, 'i').exec(text);
    if (!match) return null;
    return { slug: match[1], author: match[2], hash: match[3], marker: match[4] || '' };
  }

  /**
   * FNV-1a, so a given page URL always regenerates the same name. Shaped like
   * a real DeviantArt id: "d" plus 6 base-36 characters, 7 in total.
   */
  function generateHash(seed) {
    let h = 0x811c9dc5;
    const text = String(seed || '');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `d${h.toString(36).padStart(6, '0').slice(-6)}`;
  }

  /** Pull {author, slug} out of /{author}/art/{Title-Slug}-{id}. */
  function parsePageUrl(pageUrl) {
    try {
      const url = new URL(pageUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      const artIndex = parts.indexOf('art');
      const last = artIndex >= 0 ? parts[artIndex + 1] : parts[parts.length - 1];
      return {
        author: slugify(parts[0] || ''),
        slug: slugify(String(last || '').replace(/-\d+$/, '')),
      };
    } catch (error) {
      return { author: '', slug: '' };
    }
  }

  // Letters that lead each run, by the stem's own last character. These orders
  // are fixed by existing manual downloads and must not be reshuffled:
  //   w (-fullview) z, y, x, a, b, c, ... u, v,    0-9
  //   x (-2x)       z, y,    a, b, c, ... v, w,    0-9
  //   anything else    a, b, c, ...       y, z,    0-9
  const SIBLING_PREFIX = { w: 'zyx', x: 'zy' };

  // The "e" ending (-pre) additionally depends on how many images the
  // deviation holds, again to match downloads made by hand:
  //   up to 5 images  e, f, g, h, k
  //   exactly 6       e, f, g, h, j, k
  //   more            e, f, g, a, b, c, d, then h, i, j, k, ...
  // The leading "e" in each row is the first image's own ending, so only the
  // letters after it are handed out as sibling codes.
  function leadingLettersForE(imageCount) {
    if (imageCount <= 5) return 'fghk';
    if (imageCount <= 6) return 'fghjk';
    return 'fgabcd';
  }

  /**
   * Single-character sibling codes: the leading letters for this ending, then
   * plain alphabetical order, then the digits. The first file's own last
   * character is always skipped so no sibling can collide with it, which
   * leaves 35 codes in every case.
   *
   * @param {string} lastChar last character of the first file's stem
   * @param {number} [siblingCount] how many siblings are needed; only the "e"
   *   ending varies with it, and omitting it selects the open-ended ordering.
   */
  function siblingAlphabet(lastChar, siblingCount) {
    const skip = String(lastChar || '').toLowerCase();
    const lead = skip === 'e'
      ? leadingLettersForE(Number.isFinite(siblingCount) ? siblingCount + 1 : Infinity)
      : (SIBLING_PREFIX[skip] || '');
    const order = `${lead}${LETTERS}${DIGITS}`;
    const seen = new Set([skip]);
    return order.split('').filter((ch) => {
      if (seen.has(ch)) return false;
      seen.add(ch);
      return true;
    });
  }

  /**
   * Codes for the 2nd..Nth file: the 35 single characters first, then
   * two-character codes (a0, a1, ... z9) once those run out, which is why a
   * set of 36 or more files keeps producing distinct names.
   */
  function siblingCodes(lastChar, count) {
    const codes = siblingAlphabet(lastChar, count).slice(0, count);
    outer:
    for (const letter of LETTERS) {
      for (const digit of DIGITS) {
        if (codes.length >= count) break outer;
        codes.push(`${letter}${digit}`);
      }
    }
    return codes;
  }

  function basenameFromUrl(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch (error) {
      return String(url || '').split('?')[0].split('#')[0].split('/').pop() || '';
    }
  }

  function isVideoName(name) {
    const ext = splitExtension(name).ext.replace('.', '').toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  }

  /**
   * Assign a download filename to every item of one page.
   * @param {Array<{url:string, naturalName?:string, kind?:'image'|'video'}>} items
   *   in display order.
   * @param {{author?:string, pageUrl?:string, title?:string}} context
   * @returns {Array} the same items, each with `filename` set.
   */
  function buildDownloadNames(items, context = {}) {
    const list = (items || []).filter((item) => item && item.url);
    if (!list.length) return [];

    // The URL is the source of truth for the author: slugify() turns both
    // dashes and underscores into underscores, matching the file-name form.
    const fromUrl = parsePageUrl(context.pageUrl);
    const author = fromUrl.author || slugify(context.author);

    list.forEach((item) => {
      if (!item.naturalName) item.naturalName = basenameFromUrl(item.url);
      if (!item.kind) item.kind = isVideoName(item.naturalName) ? 'video' : 'image';
    });

    // (b) and (d): videos keep their own name behind an author prefix. Each
    // carries a distinct uuid, so they need no sibling codes to stay unique.
    list
      .filter((item) => item.kind === 'video')
      .forEach((item) => {
        item.filename = sanitizeFilename(author ? `${author}_${item.naturalName}` : item.naturalName);
      });

    const images = list.filter((item) => item.kind !== 'video');
    if (!images.length) return list;

    // (a): the first image. The rendition marker stays part of the stem, so
    // the character the siblings replace is the marker's own last letter.
    const first = images[0];
    const { stem, ext } = splitExtension(first.naturalName);
    const defaultExt = ext || '.jpg';
    let siblingStem;

    if (parseArtworkStem(stem, author)) {
      first.filename = sanitizeFilename(first.naturalName);
      siblingStem = stem;
    } else {
      const slug = fromUrl.slug || slugify(context.title) || 'image';
      siblingStem = `${slug}_by_${author || 'unknown'}_${generateHash(context.pageUrl || first.url)}-pre`;
      first.filename = sanitizeFilename(siblingStem + defaultExt);
    }

    // (c): the rest reuse that stem with the last character swapped, each
    // keeping its own extension.
    const rest = images.slice(1);
    const codes = siblingCodes(siblingStem.slice(-1), rest.length);
    const prefix = siblingStem.slice(0, -1);
    rest.forEach((item, i) => {
      const itemExt = splitExtension(item.naturalName).ext || defaultExt;
      item.filename = sanitizeFilename(`${prefix}${codes[i]}${itemExt}`);
    });

    return list;
  }

  const api = {
    buildDownloadNames,
    parseArtworkStem,
    siblingCodes,
    siblingAlphabet,
    generateHash,
    parsePageUrl,
    splitExtension,
    slugify,
    sanitizeFilename,
    basenameFromUrl,
    isVideoName,
  };

  global.MEDIA_NAMING = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
