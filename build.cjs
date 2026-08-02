// A simple, dependency-free build script for creating browser-specific extension packages.

const fs = require('fs');
const path = require('path');

// --- Configuration ---
const srcDir = path.join(__dirname, 'src');
const manifestsDir = path.join(__dirname, 'manifests');
const distDir = path.join(__dirname, 'dist');

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
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// --- Main Build Logic ---

/**
 * Builds the extension for a specific browser.
 * @param {string} browser The target browser ('firefox' or 'chrome').
 */
function build(browser) {
  if (!['firefox', 'chrome'].includes(browser)) {
    console.error(`Invalid browser specified: ${browser}. Use 'firefox' or 'chrome'.`);
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

  // 3. Copy the correct manifest file
  const manifestSrc = path.join(manifestsDir, `${browser}.json`);
  const manifestDest = path.join(browserDistDir, 'manifest.json');
  fs.copyFileSync(manifestSrc, manifestDest);

  console.log(`Successfully built for ${browser} in ${browserDistDir}`);
}

// --- Script Execution ---

const browser = process.argv[2];
if (!browser) {
  console.error('Build target not specified. Usage: node build.cjs [firefox|chrome]');
  process.exit(1);
}

build(browser);
