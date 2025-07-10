// defaults.js
// Central place for extension default settings
// Can be referenced by options.html and options.js

const DEFAULT_SETTINGS = {
  // Default folder name for downloads, created inside the browser's main Downloads folder.
  folder: "Gallery",

  // Default setting for closing tabs (false = don't close).
  closeTabs: false,

  // List of websites the extension is allowed to scan.
  // By default, all supported sites are enabled.
  allowedSites: {
    'artstation.com': true,
    'deviantart.com': true,
    'pinterest.com': true,
    'instagram.com': true,
    'flickr.com': true,
    'tumblr.com': true,
    'imgur.com': true,
    'pixiv.net': true,
    '500px.com': true,
    'reddit.com': true,
    'unsplash.com': true,
    'all_sites': false // A special flag for enabling all sites
  }
};
