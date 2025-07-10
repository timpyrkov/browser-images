// content.js
// Script injected into every tab to detect if it is an image gallery and find the main image
// Communicates with background.js to send image info
// Beginner-friendly documentation included

// Gallery detection and image extraction logic
function getMainImageUrl() {
    const hostname = location.hostname;
  
    const siteRules = {
      "imgur.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
  
      "flickr.com": () =>
        document.querySelector("meta[property='og:image']")?.content ||
        document.querySelector("img.main-photo")?.src,
  
      "deviantart.com": () =>
        document.querySelector("img[data-hook='deviation_image']")?.src,
  
      "artstation.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
      
      "instagram.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
  
      "pinterest.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
  
      "tumblr.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
  
      "reddit.com": () =>
        document.querySelector("img[alt='Post image']")?.src ||
        document.querySelector("meta[property='og:image']")?.content,
  
      "unsplash.com": () =>
        document.querySelector("meta[property='og:image']")?.content,
  
      "pixiv.net": () =>
        document.querySelector("meta[property='og:image']")?.content,
    
      "500px.com": () =>
        document.querySelector("meta[property='og:image']")?.content
};
  
    // Try exact match or partial domain match
    const rule = Object.entries(siteRules).find(([key]) =>
      hostname.includes(key)
    );
  
    if (rule) {
      const imageUrl = rule[1]();
      if (imageUrl) return imageUrl;
    }
  
    // Fallback #1: Open Graph
    const ogImage = document.querySelector("meta[property='og:image']")?.content;
    if (ogImage) return ogImage;
  
    // Fallback #2: Largest visible image
    const images = Array.from(document.images)
      .filter(img => img.complete && img.naturalWidth > 300)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return images[0]?.src || null;
  }

// Helper: Determine if this is a main image view (not a gallery) based on URL structure
function isMainImageViewUrl(hostname, pathname) {
  if (hostname.includes('artstation.com')) {
    // ArtStation: main image view contains '/artwork', gallery does not
    return pathname.includes('/artwork');
  } else if (hostname.includes('deviantart.com')) {
    // DeviantArt: gallery contains '/gallery', main image view does not
    return !pathname.includes('/gallery');
  } else {
    // TODO: Add rules for other domains
    return true; // Default: treat as main image view
  }
}

// Helper: Extract a clean, informative filename from the image URL
function extractImageFilename(imageUrl) {
  // 1. Strip query string
  let base = imageUrl.split('?')[0];
  // 2. Take everything after the last slash
  let name = base.substring(base.lastIndexOf('/') + 1);
  // 3. If empty, use a random id
  if (!name) {
    name = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  }
  // 4. Ensure valid image extension
  const validExts = [
    '.jpg', '.jpeg', '.gif', '.png', '.avif', '.webp', '.tif', '.tiff', '.bmp', '.svg', '.ico', '.heic', '.heif', '.jfif', '.pjpeg', '.pjp'
  ];
  const lower = name.toLowerCase();
  if (!validExts.some(ext => lower.endsWith(ext))) {
    name += '.jpg';
  }
  return name;
}

// Listen for a message from the background script to start scanning
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.command === 'find-main-image') {
    const imageUrl = getMainImageUrl();
    if (imageUrl) {
      if (imageUrl.startsWith('data:')) {
        console.warn('[Content] Skipping data: URL (not downloadable):', imageUrl);
        return; // No need to return true here
      }
      const hostname = location.hostname;
      const pathname = location.pathname;
      const isMainImageView = isMainImageViewUrl(hostname, pathname);
      const filename = extractImageFilename(imageUrl);
      console.log('[Content] Main image detected:', imageUrl, 'isMainImageView:', isMainImageView, 'filename:', filename);
      chrome.runtime.sendMessage({
        command: "download-image",
        imageUrl: imageUrl,
        isMainImageView: isMainImageView,
        filename: filename
      });
    }
    // No image found, do nothing.
  }
});
