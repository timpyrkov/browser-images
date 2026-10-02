<h1><p align="left">
  <img src="https://github.com/timpyrkov/browser-images/blob/master/src/icons/icon-128.png?raw=true" alt="Browser Images logo" height="25" style="vertical-align: middle; margin-right: 10px;">
  <span style="font-size:2.5em; vertical-align: middle;"><b>Browser Images</b></span>
</p></h1>

**Browser Images** — a Firefox, Chrome and Opera extension that downloads the
images and videos from the gallery tabs you have open, one click for the whole window.

Open the artworks, pins or artist galleries you want in tabs, pick the gallery in the
sidebar, press **Download**. Each tab gets a row in the sidebar log showing what was
downloaded, skipped or failed.

---

## Supported Galleries

| Gallery | Single page | Multi-image / video | Whole gallery |
|---|---|---|---|
| **ArtStation** | Artwork at full size (up to 4K) | All images and ArtStation-hosted video clips | Artist portfolio |
| **DeviantArt** | Deviation at full size | Carousels and videos | User gallery, favourites, search and tag pages |
| **Pinterest** | Pin image | Animated and video pins, multi-video pins | Board pins (stops before "more ideas") |

Third-party embeds (e.g. YouTube videos inside an ArtStation project) are skipped.

---

## Features

- **Sidebar panel** with a per-tab log, live progress, ETA, and All / Downloaded / Skipped /
  Failed filters. Close and reopen it any time: the run continues in the background and the
  log comes back (until you clear it, start a new run, or close the browser).
- **Firefox, Chrome and Opera** — the sidebar in Firefox and Opera, the side panel in Chrome.
  Chrome and Opera builds also carry a toolbar popup with the same UI as a fallback for
  browsers without an extension sidebar, e.g. **Yandex Browser** installing from the Chrome
  or Opera store. Chrome itself opens the side panel.
- **Whole galleries** — with *Download whole gallery* on, a gallery, portfolio, search or
  board tab is expanded into its individual artworks. *Follow gallery pages* walks past
  the first page.
- **Max date back** — skip artworks published before a chosen date; gallery walks stop
  early once they pass it.
- **Skip downloaded** — files already in the browser's download history are not fetched again.
- **Skip videos** and, on DeviantArt, **Prefer preview size** for smaller files.
- **Polite, adaptive pacing** — a configurable delay between downloads that grows
  automatically when a site pushes back (HTTP 403/429 or refused downloads), with
  cool-downs and retries; a tab is stopped if the site keeps refusing.
- **Per-gallery folders** — images and videos go to their own subfolders under
  `Downloads` (default `PIC` and `MOV`).
- **Close downloaded tabs** — closes only the tabs whose downloads succeeded.
- **9 interface languages** (English, German, Spanish, French, Italian, Japanese, Korean,
  Russian, Chinese) and light / dark themes.
- **No data collection** — see [PRIVACY.md](PRIVACY.md).

---

## How to Use

1. Open the tabs you want to download in one browser window. **Only the current window
   is scanned.**
2. Open the extension:
   - **Firefox:** click the toolbar icon to open the sidebar.
   - **Chrome:** click the toolbar icon to open the side panel.
   - **Opera:** open it from Opera's sidebar (pin the panel to keep it open), or use the
     toolbar popup.
   - **Yandex Browser:** click the toolbar icon for the popup.
3. Choose the gallery (ArtStation, DeviantArt or Pinterest). Only tabs from that gallery
   are processed.
4. Optionally adjust the settings (gear icon): folders, delay, max date, whole-gallery mode.
5. Press **Download**. Press **Stop** to cancel a run.

---

## Install for Development

Requires [Node.js](https://nodejs.org/).

```bash
npm run build            # lint + tests + all three builds
npm run build:firefox    # -> dist/firefox/  (sidebar only)
npm run build:chrome     # -> dist/chrome/   (side panel; toolbar popup as fallback)
npm run build:opera      # -> dist/opera/    (sidebar + toolbar popup)
npm test                 # regression tests
npm run package:firefox  # -> browser-images-firefox.zip (store upload)
npm run package:chrome   # -> browser-images-chrome.zip
npm run package:opera    # -> browser-images-opera.zip
```

**Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**
and select `dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts.

**Chrome:** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**
and select the `dist/chrome/` folder.

**Opera:** open `opera://extensions`, enable **Developer mode**, click **Load unpacked**
and select the `dist/opera/` folder.

**Yandex Browser:** open `browser://extensions` and load `dist/chrome/` or `dist/opera/` the
same way. Yandex keeps only store-installed extensions enabled across restarts.

After changing anything in `src/`, rebuild and press **Reload** on the extension.

### Project layout

```
src/
  background.js        download queue, pacing, gallery expansion
  content.js           injected into each tab; runs the gallery parser
  galleries.js         parser registry and shared helpers
  galleries/           one parser per gallery (artstation, deviantart, pinterest)
  sidebar.html/.js     the UI (also used as the Chrome/Opera toolbar popup)
  locales/             interface translations
targets/
  popup/               popup sizing, added to the Chrome and Opera builds
  chrome/              Chrome-only popup extra ("open in side panel" button)
manifests/             per-browser manifest.json
test/run.cjs           regression tests (no network)
```

---

## Roadmap

The following previously registered galleries need dedicated parsing, testing,
and maintenance before they can be enabled again:

- [ ] 500px
- [ ] Behance
- [ ] Bluesky
- [ ] Dribbble
- [ ] Flickr
- [ ] Imgur
- [ ] Instagram
- [ ] Pixiv
- [ ] Reddit
- [ ] Tumblr
- [ ] Unsplash
- [ ] Wallhaven
- [ ] X (Twitter)
- [ ] Zerochan

---

## Known Limitations

- **Duplicate checks use the browser's download history**, not the files on disk. A file
  you deleted from `Downloads` still counts as downloaded until you also remove it from
  the browser's Downloads list.
- **Pinterest boards** download what the board page has rendered; very long boards may
  need scrolling first.
- **ArtStation search pages** are not supported yet; artist portfolios are.
- Settings are stored locally in the browser and are not synced across devices.

---

## License

MIT — see [LICENSE](LICENSE).
