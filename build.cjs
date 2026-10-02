// A simple, dependency-free build script for creating browser-specific extension packages.

const fs = require('fs');
const path = require('path');

// --- Configuration ---
const srcDir = path.join(__dirname, 'src');
const manifestsDir = path.join(__dirname, 'manifests');
const targetsDir = path.join(__dirname, 'targets');
const distDir = path.join(__dirname, 'dist');

const BROWSERS = ['firefox', 'chrome', 'opera'];
// Builds that also get a toolbar popup: the fallback UI for browsers that
// install from the Chrome / Opera stores but have no sidebar for extensions
// (Yandex). Firefox stays sidebar-only.
const POPUP_BROWSERS = new Set(['chrome', 'opera']);

// --- Helper Functions ---

/**
 * Recursively copies a directory and its contents.
 * @param {string} src The source directory path.
 * @param {string} dest The destination directory path.
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * The popup is the sidebar page itself plus popup.css (fixed popup size) and,
 * where the build has one, popup.js. Generating it keeps the two from
 * drifting apart.
 */
function writePopupHtml(browserDistDir) {
  let html = fs.readFileSync(path.join(browserDistDir, 'sidebar.html'), 'utf8');
  const inject = (marker, snippet) => {
    if (!html.includes(marker)) throw new Error(`sidebar.html has no ${marker}`);
    html = html.replace(marker, `${snippet}\n${marker}`);
  };
  inject('</head>', '  <link rel="stylesheet" href="popup.css" />');
  if (fs.existsSync(path.join(browserDistDir, 'popup.js'))) {
    inject('</body>', '  <script type="module" src="popup.js"></script>');
  }
  fs.writeFileSync(path.join(browserDistDir, 'popup.html'), html);
}

// --- Main Build Logic ---

/**
 * Builds the extension for a specific browser.
 * @param {string} browser The target browser ('firefox', 'chrome' or 'opera').
 */
function build(browser) {
  if (!BROWSERS.includes(browser)) {
    console.error(`Invalid browser specified: ${browser}. Use ${BROWSERS.join(', ')}.`);
    process.exit(1);
  }

  console.log(`Building for ${browser}...`);

  const browserDistDir = path.join(distDir, browser);

  // 1. Clean up previous build
  if (fs.existsSync(browserDistDir)) {
    fs.rmSync(browserDistDir, { recursive: true, force: true });
  }
  fs.mkdirSync(browserDistDir, { recursive: true });

  // 2. Copy source files from src/ to dist/[browser]/
  copyDirRecursive(srcDir, browserDistDir);

  // 2b. Toolbar popup: shared popup files, then this browser's own extras.
  if (POPUP_BROWSERS.has(browser)) {
    copyDirRecursive(path.join(targetsDir, 'popup'), browserDistDir);
    const own = path.join(targetsDir, browser);
    if (fs.existsSync(own)) copyDirRecursive(own, browserDistDir);
    writePopupHtml(browserDistDir);
  }

  // 3. Copy the correct manifest file
  const manifestSrc = path.join(manifestsDir, `${browser}.json`);
  const manifestDest = path.join(browserDistDir, 'manifest.json');
  fs.copyFileSync(manifestSrc, manifestDest);

  console.log(`Successfully built for ${browser} in ${browserDistDir}`);
}

// --- Script Execution ---

const browser = process.argv[2];
if (!browser) {
  console.error('Build target not specified. Usage: node build.cjs [firefox|chrome|opera]');
  process.exit(1);
}

build(browser);
