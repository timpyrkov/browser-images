// defaults.js
// Central place for extension default settings

const DEFAULT_SETTINGS = {
  // Fallback folder when a gallery has no subfolders configured (relative to the browser's Downloads directory).
  folder: '',

  // Per-gallery download subfolders for images and videos, relative to the
  // browser's Downloads directory. Each key maps to { images, videos }.
  galleryPaths: {
    'artstation.com': { images: 'PIC', videos: 'MOV' },
    'deviantart.com': { images: 'PIC', videos: 'MOV' },
    'pinterest.com': { images: 'PIC', videos: 'MOV' },
  },

  // Theme: 'dark' or 'light'.
  theme: 'dark',

  // UI interface language.
  uiLang: 'en',

  // Selected gallery filter in the sidebar.
  gallery: 'artstation.com',

  // Max date back for the download log and duplicate window (empty = no limit).
  maxDate: '',

  // Delay between consecutive downloads, in seconds.
  rateLimit: 0.5,

  // Skip images already present in the browser's download history.
  skipDownloaded: true,

  // Download the gallery's smaller preview rendition instead of the full-size
  // file. Currently honoured by DeviantArt.
  preferPreview: false,

  // What to download, chosen in the toolbar and shared by every gallery:
  // 'all' (images and videos), 'images' or 'videos'. Replaces the per-gallery
  // "Skip videos" checkbox of 1.1.1 and earlier.
  mediaFilter: 'all',

  // Save .gif files to the gallery's videos folder instead of its images
  // folder; they then also count as videos for the media filter.
  gifAsVideo: false,

  // Expand a gallery / search index tab into its individual deviations and
  // download each of them. Honoured by DeviantArt galleries, Pinterest boards
  // and ArtStation portfolios / albums.
  expandGalleries: false,

  // While expanding, drive the index page's own "Next" control to reach
  // deviations beyond the first render. Falls back to whatever is already
  // loaded if no working control is found.
  galleryPaginate: true,

  // How many deviation pages are fetched concurrently while expanding.
  // Kept modest: concurrent bursts are what an adaptive rate limiter reacts to.
  batchSize: 10,
};

/*
 * The Settings panel is per gallery: each gallery keeps its own copy of these
 * values in storage.local.gallerySettings[domain], starting from the same
 * defaults above. Up to 1.1.0 they were single shared keys; those old values
 * are still read as a fallback, so nobody loses their choices on update.
 */
const GALLERY_SETTING_KEYS = ['rateLimit', 'skipDownloaded', 'preferPreview', 'gifAsVideo',
  'expandGalleries', 'galleryPaginate', 'batchSize'];

const MEDIA_FILTERS = ['all', 'images', 'videos'];

/**
 * The toolbar media filter. Before 1.1.2 there was a "Skip videos" checkbox
 * instead (shared up to 1.1.0, then per gallery); whoever had it ticked for
 * the selected gallery starts with "Only images".
 */
function mediaFilterFor(stored) {
  if (stored && MEDIA_FILTERS.includes(stored.mediaFilter)) return stored.mediaFilter;
  const gallery = (stored && stored.gallery) || DEFAULT_SETTINGS.gallery;
  const own = stored && stored.gallerySettings && stored.gallerySettings[gallery];
  const skipVideos = (own && own.skipVideos) ?? (stored && stored.skipVideos);
  return skipVideos === true ? 'images' : DEFAULT_SETTINGS.mediaFilter;
}

/** The skip flags a media filter stands for; anything unknown means 'all'. */
function mediaFilterFlags(filter) {
  return { skipImages: filter === 'videos', skipVideos: filter === 'images' };
}

/** One gallery's settings: its own value, else the old shared value, else the default. */
function gallerySettingsFor(stored, gallery) {
  const own = (stored && stored.gallerySettings && stored.gallerySettings[gallery]) || {};
  const settings = {};
  for (const key of GALLERY_SETTING_KEYS) {
    settings[key] = own[key] ?? (stored ? stored[key] : undefined) ?? DEFAULT_SETTINGS[key];
  }
  return settings;
}

self.GALLERY_SETTINGS = { keys: GALLERY_SETTING_KEYS, forGallery: gallerySettingsFor };
self.MEDIA_FILTER = { values: MEDIA_FILTERS, resolve: mediaFilterFor, flags: mediaFilterFlags };
