// defaults.js
// Central place for extension default settings

const DEFAULT_SETTINGS = {
  // Fallback folder for custom/unknown domains (relative to the browser's Downloads directory).
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
  // Shared across all galleries, like rateLimit.
  skipDownloaded: true,

  // Download the gallery's smaller preview rendition instead of the full-size
  // file. Shared across all galleries; currently honoured by DeviantArt.
  preferPreview: false,

  // Download only images, leaving videos (mp4/webm/...) alone.
  skipVideos: false,

  // Expand a gallery / search index tab into its individual deviations and
  // download each of them. Honoured by DeviantArt and Pinterest boards.
  expandGalleries: false,

  // While expanding, drive the index page's own "Next" control to reach
  // deviations beyond the first render. Falls back to whatever is already
  // loaded if no working control is found.
  galleryPaginate: true,

  // How many deviation pages are fetched concurrently while expanding.
  // Kept modest: concurrent bursts are what an adaptive rate limiter reacts to.
  batchSize: 10,
};
