# Privacy Policy for Image Downloader for Gallery Tabs

**Effective date:** October 1, 2026

## What data this extension collects

Image Downloader for Gallery Tabs does **not** collect, store, or transmit any personal data.

## What this extension does

Image Downloader for Gallery Tabs is a browser extension that helps users download images and videos they are already viewing in open browser tabs.

All image and video downloads are performed directly by the browser's own download API. Downloaded files are saved to the user's local Downloads folder or the subfolder configured in the extension settings.

## Data handling

- No browsing history, page content, visited URLs, or metadata is sent to any external server.
- No analytics, telemetry, crash reports, or advertising identifiers are collected.
- User preferences (download folder, rate limit, selected gallery, etc.) are stored only in the browser's local extension storage.
- When a supported gallery page is scanned, the extension may fetch individual artwork pages using the same cookies the browser already has for that site; these requests are made directly to the gallery's own servers, not to any intermediary.

## Permissions used and why

- **tabs / activeTab**: to identify the currently focused tab and read its URL when the user clicks the extension icon.
- **scripting**: to inject the small gallery-detection content scripts into tabs at scan time.
- **downloads**: to save detected images and videos to the user's Downloads folder.
- **storage**: to remember the user's preferences (folder, gallery, theme, language, etc.) locally in the browser.
- **`<all_urls>`**: the extension can work on any website the user visits; this host permission is required to inject the scanner script and detect supported gallery pages.

## Contact

For questions about this privacy policy, please open an issue in the project repository:
https://github.com/timpyrkov/browser-images
