<h1><p align="left">
  <img src="https://github.com/timpyrkov/download-img/blob/master/src/icons/icon-48.png?raw=true" alt="logo" height="30" style="vertical-align: middle; margin-right: 10px;">
  <span style="font-size:2.5em; vertical-align: middle;"><b>Download Images from Gallery Tabs</b></span>
</p></h1>

A cross-browser extension for Firefox and Google Chrome that scans your open tabs for image gallery pages, downloads the main image from each, and optionally closes the tab after the download is complete.

---

## Core Features

- **One-Click Downloads:** A simple popup menu with a "Scan & Download" button to start the process.
- **Smart Domain Filtering:** Only scans tabs from websites you've allowed. You can choose from a list of popular gallery sites or enable scanning for all websites.
- **Duplicate Prevention:** The extension intelligently checks if a file already exists in your download folder (based on its filename) and will not download it again.
- **Custom Download Folder:** Specify a subfolder name (e.g., "Gallery") inside your browser's main `Downloads` directory.
- **Optional Tab Closing:** Choose whether to automatically close a tab after its image has been successfully downloaded.
- **Persistent Settings:** All your preferences are saved and loaded automatically.

---

## How to Build and Install for Development

This project uses a simple Node.js build script to create browser-specific packages. This is required because Chrome and Firefox have different `manifest.json` requirements.

### Prerequisites

You must have [Node.js](https://nodejs.org/) installed to run the build script.

### Step 1: Build the Extension

From the root of the project folder, open your terminal and run one of the following commands:

-   **For Firefox:**
    ```bash
    npm run build:firefox
    ```
-   **For Chrome (and other Chromium browsers):**
    ```bash
    npm run build:chrome
    ```

This will create a `dist/[browser]` folder (e.g., `dist/firefox`) containing the ready-to-install extension package.

### Step 2: Install the Extension

Now, load the generated package into your browser:

-   **In Firefox:**
    1.  Navigate to `about:debugging#/runtime/this-firefox`.
    2.  Click **"Load Temporary Add-on..."**
    3.  Select the `manifest.json` file inside the `dist/firefox` folder.

-   **In Chrome:**
    1.  Navigate to `chrome://extensions`.
    2.  Enable **"Developer mode"**.
    3.  Click **"Load unpacked"**.
    4.  Select the entire `dist/chrome` folder.

To apply any code changes you make in the `src` folder, you must re-run the build command and then reload the extension in your browser. 

### Permanent Installation in Firefox (Unsigned Add-on)

If you want to use the extension permanently in Firefox (not just as a temporary add-on):

1. Go to `about:config` in Firefox and set `xpinstall.signatures.required` to `false` (for developer/testing use only).
2. Go to `about:addons` → click the gear icon → "Install Add-on From File..."
3. Select the `manifest.json` file from this project.
4. The extension will remain installed across browser restarts, but will be marked as “Unsigned.”

*Note: This is only recommended for personal/development use. For production, submit to [addons.mozilla.org](https://addons.mozilla.org/).*

---

## How to Use

1.  **Configure Your Settings:** Click the extension's icon in the toolbar and select **"Settings"**. Here you can set your preferred download folder, choose which websites to scan, and decide if tabs should close after downloading.
2.  **Open Image Tabs:** Open one or more browser tabs to the main image pages you want to download (e.g., a specific image on DeviantArt, ArtStation, etc.).
3.  **Start the Scan:** Click the extension icon again and press the **"Scan & Download"** button.
4.  The extension will scan your open tabs, find the main images on the allowed domains, and download any new images to your specified folder.

---

## Project To-Do & Nice-to-Have Features

This is a list of potential improvements and features for the future.

- [ ] **Switch to Sync Storage Before Release:**  
      Change all `chrome.storage.local` to `chrome.storage.sync` in all scripts for cross-device sync before publishing.
- [ ] **UI/UX Polish:**
    - [ ] Add a visual progress bar during the download process.
    - [ ] Show an image preview in the popup before downloading.
    - [ ] Refactor the options page for a cleaner, more modern look.
- [ ] **Core Functionality:**
    - [ ] Allow users to define custom filename templates (e.g., `{domain}-{date}-{title}`).
    - [ ] Add support for downloading images from background tabs without needing to activate them.
- [ ] **Advanced Options:**
    - [ ] Implement keyboard shortcuts for scanning.
    - [ ] Allow per-domain settings (e.g., close tabs for Site A but not for Site B).

---

## Known Limitations

- Duplicate checking is based on the browser’s downloads history, not the actual files on disk. If you delete a file from your Downloads folder but not from the browser’s Downloads page/history, the extension will still consider it as “already downloaded.”

---

## Troubleshooting

- **Why does the extension say a file already exists when I deleted it?**  
  The extension checks the browser’s downloads history, not the actual files. To re-download a file, remove its entry from the browser’s Downloads page as well.

---

### A Note for Developers

> During development, the extension uses `chrome.storage.local` for settings storage. Before any potential publishing to an add-on store, this should be switched to `chrome.storage.sync` in all relevant scripts to enable cross-device synchronization of user settings.
