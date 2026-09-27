# Registering a Firefox extension for permanent installation

How to turn a temporary `about:debugging` add-on into one that survives browser
restarts. Written to be copied into any Firefox extension project — replace the
`<placeholders>` and adjust paths to match the project layout.

## Why this is needed

`about:debugging` → "Load Temporary Add-on" is wiped on every restart.

On **Firefox release and beta**, the `xpinstall.signatures.required` preference is
locked: setting it to `false` in `about:config` has no effect. A permanent install
therefore requires a **signed** XPI. There is no way around this on the release
channel.

Signing is not the same as publishing. AMO has an *unlisted* (self-distribution)
channel: you upload, an automated validator signs it, you download the XPI, and it
never appears in the public add-on directory. It is free and normally takes minutes.

## Route A — unlisted signing (recommended, stays on release Firefox)

### 1. Give the extension a permanent add-on ID

Required for signing. In the Firefox manifest:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "<extension-slug>@<your-handle>",
    "strict_min_version": "115.0"
  }
}
```

- The ID is an identifier, not a real email address, but it must be **globally
  unique** and **never change** — it is how Firefox recognises a later upload as an
  update to the same add-on rather than a different extension.
- Every extension you own needs its **own distinct ID**. Do not reuse one across
  projects.
- `strict_min_version` is optional; `115.0` is a safe ESR-era baseline for an
  MV3 extension.

### 2. Build the upload package

AMO accepts a ZIP or XPI with `manifest.json` **at the archive root** (not inside a
subfolder). If the project builds into `dist/firefox/`:

```bash
cd dist/firefox && zip -qrX -FS ../../<extension-slug>-firefox.zip . -x '*.DS_Store'
```

Worth wiring into `package.json` as a script so it is one command:

```json
"package:firefox": "npm run build:firefox && rm -f <extension-slug>-firefox.zip && cd dist/firefox && zip -qrX -FS ../../<extension-slug>-firefox.zip . -x '*.DS_Store'"
```

Verify before uploading:

```bash
unzip -l <extension-slug>-firefox.zip | head
```

### 3. Upload and get it signed

1. Create an account at <https://addons.mozilla.org/developers/>.
   Mozilla **requires 2FA** on add-on developer accounts.
2. Submit a New Add-on → choose **"On your own"** (this is the unlisted channel).
3. Upload the zip. Automated validation runs; fix any errors it reports and
   re-upload.
4. Download the signed `.xpi` when it appears.

### 4. Install it

`about:addons` → gear icon → **Install Add-on From File…** → select the signed XPI.

It now behaves like any normal extension and survives restarts.

### Faster path once set up

Get an API key at <https://addons.mozilla.org/developers/addon/api/key/>, then
steps 2–4 collapse to:

```bash
npx web-ext sign --source-dir=dist/firefox --channel=unlisted --api-key=<jwt-issuer> --api-secret=<jwt-secret>
```

`npx web-ext lint --source-dir=dist/firefox` catches most validation errors before
you upload.

## Updating a signed extension

- **Bump the version in the manifest every time.** AMO rejects a re-upload of a
  version number it has already seen. Keep `manifest.json` and `package.json`
  versions in sync.
- Re-sign, then install the new XPI the same way. Because the add-on ID matches,
  Firefox upgrades it in place instead of adding a second copy.
- Firefox will **not** auto-update a self-distributed add-on unless the manifest
  declares an `update_url` pointing at an update manifest you host. Without one,
  updating is manual — usually fine for personal tools.

## Route B — a browser channel that allows unsigned add-ons

Install **Firefox Developer Edition, Nightly, or ESR**, then:

1. `about:config` → set `xpinstall.signatures.required` to `false`.
2. Install the XPI directly — no AMO account, no review.

The add-on ID from step 1 of Route A is still needed. The cost is running a
separate browser (or switching to ESR full time). Mozilla also publishes
"unbranded" release/beta builds for the same purpose.

## What does not work

- `xpinstall.signatures.required` on **release or beta** Firefox — ignored.
- Enterprise `policies.json` — it can force-install an extension, but it cannot
  waive the signature requirement on release.
- Renaming a `.zip` to `.xpi` — unsigned is unsigned.

## Note on review

Self-distributed add-ons are signed automatically, but are still subject to manual
review afterwards. Broad permissions — `<all_urls>`, `downloads`, `tabs`,
`webRequest` — draw closer attention. Legitimate tools pass, but the review is real
and is not instantaneous the way the signing step is.

## Per-project checklist

- [ ] Unique, permanent `browser_specific_settings.gecko.id` in the manifest
- [ ] Version bumped, and consistent between `manifest.json` and `package.json`
- [ ] `npm run package:firefox` produces a zip with `manifest.json` at the root
- [ ] `npx web-ext lint` clean
- [ ] Uploaded to AMO on the **"On your own"** channel
- [ ] Signed XPI installed via `about:addons` → gear → Install Add-on From File…
- [ ] Signed XPI archived somewhere outside the repo (zips are usually gitignored)

## Sources

- <https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/>
- <https://wiki.mozilla.org/Add-ons/Extension_Signing>
