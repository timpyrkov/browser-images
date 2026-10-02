# Privacy Policy for Image Downloader for Gallery Tabs

**Last updated:** 2026-10-02

## Summary

Image Downloader for Gallery Tabs is a browser extension that downloads the images and videos from the gallery tabs you have open (ArtStation, DeviantArt, Pinterest). The extension does **not** collect, store, or transmit any personal information, browsing data, or user content to servers owned or operated by the developer. There are no such servers.

Everything happens inside your browser: the extension reads the gallery pages you have open, asks those galleries' own servers for the artwork files, and saves them with the browser's built-in downloader to your `Downloads` folder.

## When the extension does anything

Nothing runs in the background or on its own. The extension only reads pages and makes requests after you press **Download** in its sidebar (or popup), and only for tabs in the current window that belong to the gallery you selected. Press **Stop** to end a run at any time.

## Information the extension accesses

### Open tabs

When you press **Download**, the extension lists the tabs in the current browser window and reads their address and title to decide which ones belong to the selected gallery. If you press **Close downloaded tabs**, it closes only the tabs whose downloads succeeded.

### Gallery page content

In each matching tab, the extension runs a small script that finds the artwork's image and video addresses on the page. Page content is used only for that, inside your browser, and is never sent anywhere else.

### Download history

When **Skip downloaded** is on, the extension searches the browser's own download history for a file's name to avoid downloading it twice. It also watches the state of the downloads it started (finished, interrupted) to pace the run. This information stays in your browser.

### Settings and preferences

The following are stored locally in your browser's extension storage and never transmitted anywhere:

- Selected gallery, download subfolders, delay between downloads, batch size
- Max date, skip downloaded / skip videos / prefer preview / whole gallery / follow pages options
- Interface language and theme

### Download log

The per-tab log of the current run (each tab's title and address, file names, and downloaded / skipped / failed status, plus the time the run started) is kept in the browser's **session storage** so it is still there when you close and reopen the sidebar or popup. Session storage is held in memory, never written to disk, and not readable by web pages. The log is never transmitted anywhere.

## What is kept and what is erased

Only your **settings** are stored permanently. Everything about your downloads is temporary and disappears at the latest when the browser closes.

| | Settings | Download log |
|---|---|---|
| Where it is stored | Extension storage, on disk | Session storage, in memory only |
| Closing and reopening the panel | kept | kept |
| Pressing **Clear list** | kept | **erased** |
| Starting a new download | kept | **erased** (replaced by the new run) |
| Restarting the browser | kept | **erased** |
| Reloading, updating or disabling the extension | kept | **erased** |
| Uninstalling the extension | **erased** | **erased** |

### The Clear list button

**Clear list** erases the whole download log at once: the list shown in the panel and the stored copy, including the run's start time. Afterwards nothing about past downloads remains in the extension, even if you close and reopen the panel. Your settings are not affected.

The button is unavailable while a download is running (press **Stop** first), because the running download would immediately add its progress back to the list.

### What the extension does not erase

The downloaded files, and their entries in the browser's own **Downloads** list, belong to the browser, not to the extension. Neither Clear list nor a browser restart removes them. You can remove the entries from the browser's Downloads page; note that **Skip downloaded** relies on that list to recognise files you already have, so files removed from it will be downloaded again.

## Network requests

All requests go directly from your browser to the gallery you are downloading from and its own file servers. There is no relay, proxy, or intermediary server operated by the extension author. The requests carry your browser's existing cookies for that site, exactly as if you opened the pages yourself, so content you can see while logged in can be downloaded.

| Gallery | What is requested |
|---|---|
| ArtStation | The artwork's and artist's public data (`/projects/…json`, `/users/…/projects.json`), video-clip player pages, and the image/video files (`cdn*.artstation.com`). Requested from inside your ArtStation tab. |
| DeviantArt | The individual deviation pages of a gallery or search page, and the image/video files. |
| Pinterest | Only the image/video files (`*.pinimg.com`) already shown on the pin or board page. |

## Data the extension does **not** collect

- No analytics, telemetry, crash reporting, or advertising identifiers
- No browsing history, bookmarks, passwords, or cookies are read or sent anywhere
- No data is sold, shared, or stored by the extension author

## Permissions explained

- **`tabs` / `activeTab`:** List the tabs in the current window, read their address and title to match the selected gallery, and close downloaded tabs when you ask.
- **`scripting`:** Inject the small gallery-detection script into matching tabs when you press Download.
- **`downloads`:** Save images and videos to your `Downloads` folder, check the download history for duplicates, and track download progress for pacing.
- **`storage`:** Save your preferences locally, and keep the current run's log in session storage (memory only) so it survives closing and reopening the panel.
- **`<all_urls>`:** Run the detection script on gallery pages and request gallery pages and files, which live on several domains and file servers.
- **`sidePanel`** (Chrome) / **sidebar** (Firefox, Opera): Show the extension's interface in the browser's side panel.

## Changes to this policy

If the extension ever starts handling data differently, this file will be updated and the change will be noted in the release notes.

## Contact

For questions about this privacy policy, open an issue in the repository:
https://github.com/timpyrkov/browser-images/issues
