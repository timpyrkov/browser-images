// defaults.js
// Central place for extension default settings

const DEFAULT_SETTINGS = {
  // Fallback folder for custom/unknown domains (relative to the browser's Downloads directory).
  folder: '',

  // Per-gallery download subfolders for images and videos, relative to the
  // browser's Downloads directory. Each key maps to { images, videos }.
  galleryPaths: {
    'artstation.com': { images: 'PIC', videos: 'MOV' },
    'behance.net': { images: 'PIC', videos: 'MOV' },
    'bsky.app': { images: 'PIC', videos: 'MOV' },
    'deviantart.com': { images: 'PIC', videos: 'MOV' },
    'dribbble.com': { images: 'PIC', videos: 'MOV' },
    'flickr.com': { images: 'PIC', videos: 'MOV' },
    'imgur.com': { images: 'PIC', videos: 'MOV' },
    'instagram.com': { images: 'PIC', videos: 'MOV' },
    'pinterest.com': { images: 'PIC', videos: 'MOV' },
    'pixiv.net': { images: 'PIC', videos: 'MOV' },
    'reddit.com': { images: 'PIC', videos: 'MOV' },
    'tumblr.com': { images: 'PIC', videos: 'MOV' },
    'x.com': { images: 'PIC', videos: 'MOV' },
    'unsplash.com': { images: 'PIC', videos: 'MOV' },
    '500px.com': { images: 'PIC', videos: 'MOV' },
    'wallhaven.cc': { images: 'PIC', videos: 'MOV' },
    'zerochan.net': { images: 'PIC', videos: 'MOV' },
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
  rateLimit: 1.5,

  // Skip images already present in the browser's download history.
  // Shared across all galleries, like rateLimit.
  skipDownloaded: true,

  // Download the gallery's smaller preview rendition instead of the full-size
  // file. Shared across all galleries; currently honoured by DeviantArt.
  preferPreview: false,
};
