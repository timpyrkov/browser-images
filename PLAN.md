# Browser Images — Refactoring Plan

## What this project does

**Browser Images** is a cross-browser extension (Firefox primary, Chrome secondary) that scans open tabs for the "main" image on known gallery/image-hosting sites and downloads it into a configurable subfolder of the browser's Downloads directory. The user opens one or more image-detail tabs (e.g. a DeviantArt deviation, an ArtStation artwork, a Pinterest pin), opens the extension sidebar, and clicks **Scan & Download**. The extension:

1. Queries all open tabs.
2. Filters them by allowed domains.
3. Injects a content script to locate the largest / Open Graph / site-specific main image.
4. Downloads each image to `<Downloads>/<folder>/`.
5. Optionally closes the tab after a successful download.
6. Avoids re-downloading files it already sees in the browser's downloads history.

All controls and settings live in the sidebar. There is no separate popup or options window.

## Supported image galleries (initial set)

The extension ships with extraction rules for the following public, SFW-oriented art/photo communities and social platforms. Each rule targets the *detail/single-image* view of a gallery post, not the gallery grid or feed. Users will be able to add custom domains in the sidebar settings.

| Site | Primary domain | Detail-page signal |
|------|----------------|--------------------|
| ArtStation | `artstation.com` | `/artwork/` path |
| Behance | `behance.net` | project pages |
| Bluesky | `bsky.app` | post permalinks |
| DeviantArt | `deviantart.com` | non-`/gallery/` deviation URLs |
| Dribbble | `dribbble.com` | shot pages |
| Flickr | `flickr.com` | `/photos/<user>/<id>/` |
| Imgur | `imgur.com` | `/gallery/` and direct image pages |
| Instagram | `instagram.com` | `/p/<shortcode>/` |
| Pinterest | `pinterest.com` | `/pin/` |
| Pixiv | `pixiv.net` | `/artworks/` |
| Reddit | `reddit.com` | `/comments/` gallery/image posts |
| Tumblr | `tumblr.com` | post permalinks |
| X (Twitter) | `x.com` | post permalinks |
| Unsplash | `unsplash.com` | `/photos/` |
| 500px | `500px.com` | `/photo/` |
| Wallhaven | `wallhaven.cc` | wallpaper detail pages |
| Zerochan | `zerochan.net` | image detail pages |

Generic fallback rules will also apply to any allowed domain: site-specific selectors first, then Open Graph `og:image`, then the largest visible image on the page.

## Sidebar design

The UI is a single sidebar surface with a top toolbar and a scrollable main working area, closely mirroring `browser-translations`.

### Toolbar controls (left to right)

All toolbar controls share the same `32px` height, use the same group-gap spacing (`toolbar-group-gap`), and align on a single row that can wrap on narrow side panels.

1. **Project icon** — `icons/icon-32.png`, rounded 6px, first element.
2. **Interface language selector** — dropdown to switch the UI language. Reuses the `browser-translations` i18n modules (`i18n.js`, `languages.js`, `locales/*.js`) and the same nine languages: English, Spanish, Italian, French, German, Russian, Korean, Japanese, Chinese.
3. **Gallery selector** — dropdown that picks the active gallery/site filter (e.g. "All galleries", "ArtStation", "DeviantArt", "Custom sites"). The default is "All galleries".
4. **Gallery settings button** — gear icon to the right of the gallery selector. Opens a dropdown panel with gallery-specific settings: per-domain allowlist checkboxes, custom-domain input, and selector for image vs. media fallback behavior.
5. **Download path input** — text field showing the current subfolder inside the browser Downloads directory (e.g. `Gallery`).
6. **Max date backwards** — date picker / calendar dropdown that sets how far back the download log/history is shown and how far back duplicate checking looks. Default: today / no limit.
7. **Download button** — primary accent (gold/olive gradient) button labeled **Download**. Starts scanning all allowed open tabs and downloading the main images.
8. **Theme toggle** — right-most moon/sun button. Reuses `theme.js` and switches between dark and light.

A collapsible settings dropdown is opened by the gear icon; the rest of the controls are always visible.

### Main working area — download log

The main area is a scrollable log of every tab/media item the current scan touches. Each row shows:

- **Source** — page title and domain.
- **Thumbnail preview** — small image preview when available; a generic placeholder for videos or unsupported previews.
- **Filename** — the name that will be / was saved.
- **Status** — queued / scanning / downloading / downloaded / skipped (duplicate or not main image) / error.
- **Timestamp** — when the action happened.
- **Error message** — shown only for failures.

Above the log, a compact summary bar shows counts: total scanned, downloaded, skipped, failed. Filter chips let the user show all rows or only downloaded / failed / skipped. The **Max date backwards** control filters the log to entries from that date onward.

This log replaces both the old popup status message and the old options page; the sidebar is the only UI surface.

## Current state — what works and what's fragile

The repo already has the right shape:

- `src/` contains `background.js`, `content.js`, `sidebar.html/js` (replacing the old `popup.html/js` and `options.html/js`), `defaults.js`, `styles.css`, and `icons/` (currently empty).
- `manifests/chrome.json` and `manifests/firefox.json` provide per-browser MV3 manifests.
- `build.js` assembles a `dist/[browser]/` package by copying `src/` and the matching manifest.

However, there are several blockers that prevent it from being robust:

- **Missing `downloadImage()` function in `background.js`:** at `src/background.js:78` the code calls `downloadImage(response.imageUrl, response.filename, settings, tab.id)`, but that function does not exist. The download logic lives in the `download-image` message handler, but the two flows are not connected correctly.
- **Message-flow mismatch:** `background.js` sends `find-main-image` to a tab and `await`s a response, but `content.js` replies by calling `chrome.runtime.sendMessage({ command: "download-image", ... })` rather than using `sendResponse`. The awaited response is therefore `undefined`, so `response.status === 'found-image'` is never true.
- **Chrome service-worker cannot see `DEFAULT_SETTINGS`:** `defaults.js` defines the constant, but `background.js` is a service worker in Chrome. The current build prepends `importScripts('defaults.js')`, which is fine, but the code mixes direct `DEFAULT_SETTINGS` use with `chrome.storage.local.get(...)` calls in a brittle way.
- **Duplicate detection is unreliable:** it relies on `item.exists`, which is not part of the `chrome.downloads.DownloadItem` API on Firefox, and the path-matching logic is fragile.
- **No download-completion feedback before closing tabs:** tabs may be closed before the file is actually written.
- **Hard-coded site rules with no tests or escape hatches:** adding a new site means editing `content.js`.
- **No runtime verification:** no build-time lint, no test HTML, and the `icons/` directory is empty, so the packaged extension fails its own icon references.
- **Visual/UX debt:** the popup and options pages work but use an older styling approach; the related [browser-translations](file:///Users/timpyrkov/playground/browser-translations) project has a much cleaner palette, theme toggle, button system, and layout primitives we should adopt.

## Template to follow: `browser-translations`

The translation extension in `~/playground/browser-translations/` is the refined reference for this refactor. We will borrow from it, not copy every feature:

- **Color palette & CSS tokens** in `src/styles.css` (`--neutral-*`, `--primary-*`, `--secondary-*`, semantic aliases, dark-by-default, `data-theme="light"` override).
- **`theme.js` pattern** for a single, reusable dark/light toggle stored in extension local storage.
- **i18n architecture** (`src/i18n.js`, `src/languages.js`, `src/locales/*.js`) for the nine UI languages: English, Spanish, Italian, French, German, Russian, Korean, Japanese, Chinese.
- **Button/checkbox/radio styling** (`btn`, `btn-green`, `btn-grey`, custom checkboxes, form groups, `.page-header`).
- **Cross-browser API wrapper** (`const brw = typeof browser !== "undefined" ? browser : chrome;`) and promise-first usage.
- **Build & manifest conventions** (`npm run build:firefox`, `npm run build:chrome`, `dist/[browser]/`).
- **Error handling and logging discipline** (specific prefixes, no swallowed errors).

We *will* convert Browser Images into a sidebar-only extension. The sidebar will host both the quick scan controls and the settings panel, replacing both the old popup and the separate options page. There will be no popup, dropdown, or separate options window.

## Phase-based refactoring plan

### Phase 0 — Audit, fix blockers, and make it build

1. **Fix `background.js` message flow:** make the content script return an explicit result via `sendResponse` (or have the background listen for the `download-image` event directly) and remove the non-existent `downloadImage()` call.
2. **Verify defaults loading:** ensure `DEFAULT_SETTINGS` is available in both Firefox background scripts and the Chrome service worker.
3. **Add missing icon assets** under `src/icons/` (16/32/48/128 px) so manifests resolve.
4. **Add a minimal syntax/lint step** to catch undeclared variables and broken message flows (e.g. `eslint` or a small Node smoke test).
5. **Update `.gitignore`** if needed and confirm `npm run build` produces working `dist/firefox/` and `dist/chrome/` packages.

**Deliverable:** extension builds and the core scan/download path no longer crashes on basic use.

### Phase 1 — Align architecture and visual system with `browser-translations`

1. **Adopt the shared design tokens:** replace the current `styles.css` palette and components with the `browser-translations` neutral/primary/secondary token system, keeping only image-specific overrides.
2. **Introduce `src/theme.js`:** central dark/light handling, replace the duplicated `setThemeClass()` logic that currently lives in the old popup and options scripts, and wire it into the new `sidebar.js`.
3. **Create `src/sidebar.html` and `src/sidebar.js`** as the single UI surface, matching the layout described in the *Sidebar design* section: project icon, UI-language dropdown, gallery selector + gear settings panel, download-path input, max-date picker, **Download** button, and theme toggle. The main area is a scrollable download log. Remove `popup.html`, `popup.js`, `options.html`, and `options.js` once the sidebar replaces them.
4. **Introduce a cross-browser API helper** (`src/api.js` or inline `brw` wrapper) and standardize on promise-style storage/tabs/downloads calls.
5. **Simplify the build script:** remove the `importScripts` injection hack; load `defaults.js` consistently for both browsers (service worker or background scripts).
6. **Clean up manifests:** ensure permissions are minimal but sufficient (`tabs`, `downloads`, `storage`, `scripting`, `activeTab`, `<all_urls>` host permission), and both manifests point at the same `src/` files.

**Deliverable:** UI visually matches the reference template, code no longer has duplicated theme logic, and the same source builds cleanly for both browsers.

### Phase 2 — Harden the core download engine

1. **Rewrite `content.js` image extraction:**
   - Site rules as a declarative array/map so adding a new host is one entry.
   - Robust URL resolution (relative URLs, query-stripped variants, protocol-relative URLs).
   - Reject `data:`, `blob:`, and invalid URLs cleanly.
   - Fallback chain: site rule → `og:image` → largest visible image (>300 px).
2. **Add filename utilities:**
   - Sanitize folder and filenames for the OS and browser download API.
   - Optional simple template support (e.g. `{domain}-{date}-{title}`) without over-engineering.
   - Preserve or infer correct extension.
3. **Fix duplicate detection:**
   - Use `chrome.downloads.search({ filenameRegex: ... })` or filename matching plus `state: 'complete'`.
   - Handle the missing `exists` property on Firefox by falling back to history-based de-duplication.
4. **Make tab closing reliable:**
   - Wait for `chrome.downloads.onChanged` to report `state === 'complete'` (or failure) before closing the tab.
   - Do not close tabs when a download is skipped or errors.
5. **Add basic rate limiting:** keep the per-download random delay but make it configurable and expose progress updates to the sidebar.
6. **Add comprehensive error reporting:** every failed tab/injection/download should report a human-readable reason.

**Deliverable:** downloads succeed reliably, tabs close only after confirmed success, duplicate logic works on both browsers, and users get useful status messages.

### Phase 3 — UI/UX improvements

1. **Sidebar toolbar:** implement the full control bar (project icon, UI-language selector, gallery selector, gallery-settings gear, download-path input, max-date picker, **Download** button, theme toggle) with the same `32px` heights and grouped spacing as `browser-translations`.
2. **Main working area — download log:** live list of scanned tabs with thumbnail preview, filename, and status (queued / scanning / downloading / downloaded / skipped / error). Include counts for total, downloaded, skipped, and failed, plus filter chips for status.
3. **Gallery settings dropdown:** opened by the gear icon, containing:
   - Per-domain allowlist with a search/filter field.
   - "Close tab after download" toggle.
   - Rate-limit delay between downloads.
   - Custom-domain input for user-added sites.
4. **Add a short onboarding hint** in the sidebar when no allowed sites are selected or when no image tabs are open.
5. **Add a test HTML page** (`test.html`) with a few static "gallery detail" fixtures so the extension can be exercised without visiting live sites.

**Deliverable:** a polished, informative UI that behaves consistently in dark and light themes.

### Phase 4 — Testing and documentation

1. **Manual end-to-end tests** in Firefox and Chrome using `dist/firefox/` and `dist/chrome/`.
2. **Add a simple automated check** that parses the JS and simulates the content-script extraction against the local `test.html`.
3. **Update `README.md`:** rewrite install/development instructions, document supported sites, and remove outdated TODOs.
4. **Add `CHANGELOG.md`** to track what was fixed/refactored.

**Deliverable:** reliable manual and automated verification, plus up-to-date docs.

### Phase 5 — Store-readiness packaging

1. **Decide on storage backend:** evaluate switching from `chrome.storage.local` to `chrome.storage.sync` for cross-device settings, or keep local-only with a clear note.
2. **Icon finalization:** ensure all required icon sizes are crisp and follow store guidelines.
3. **Review manifest metadata** (name, description, version) and prepare an unsigned `.xpi`/zip for testing.
4. **Register developer accounts** and submit for internal/self-signed testing before any public listing.

**Deliverable:** extension is installable and survives browser restarts without temporary-add-on reloads.

## Immediate next step

Start with **Phase 0**: fix the `background.js` / `content.js` message flow, restore missing icons, and verify `npm run build` produces loadable packages for both browsers. This unblocks the rest of the refactor.
