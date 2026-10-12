'use strict';
// Regression suite for the extension's pure logic. Run with: npm test
// Loads the real source files into a stubbed browser environment; no network.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');

let fails = 0, checks = 0;
function eq(label, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log(`  FAIL ${label}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`); }
}
const section = (name) => console.log(`\n${name}`);

/* ---------------------------------------------------------------- naming */
function loadNaming() {
  const s = { console, URL, Math, Set, RegExp, Number, module: { exports: {} } };
  s.self = s; vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/naming.js'), 'utf8'), s, { filename: 'naming.js' });
  return s.MEDIA_NAMING;
}

/* ------------------------------------------------------------ background */
// The extension's own id, and a sender as the sidebar / popup appears (no tab).
const EXT_ID = 'browser-images@test';
const PANEL = { id: EXT_ID };
// `interrupts` maps a URL to the reasons its next downloads are interrupted
// with, e.g. { 'https://x/a.jpg': ['SERVER_FORBIDDEN'] }; `'*'` applies to all.
// `session` is the storage.session backing object; pass the same one to a
// second loadBackground() to simulate the browser unloading and restarting
// the background. `openTabs` are the tab ids tabs.query({}) reports.
// `sidePanel`: 'ok' mimics Chrome, 'fails' a side panel API that rejects,
// absent mimics Yandex / Opera (no chrome.sidePanel).
function loadBackground({ history = [], failUrls = [], interrupts = {}, session = {}, openTabs = [], sidePanel,
  scriptResult, local = {} } = {}) {
  const broadcasts = [], started = [], intervals = [], fetched = [], removed = [], localRemoved = [], scriptCalls = [];
  const panel = { behavior: [], popups: [], onStartup: [] };
  const finalState = {};
  let handler = null;
  const s = { console: { log(){}, warn(){}, error(){} },
    // Run timers at once, except the 120 s settle timeout, which must not win
    // the race against the download's real outcome.
    setTimeout: (fn, ms) => (ms === 120000 ? 0 : fn()), clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => intervals.splice(id - 1, 1),
    Math, Date, URL, Promise, Number, Set, Error, AbortController,
    chrome: {
      runtime: { id: EXT_ID, onInstalled: { addListener(){} }, onMessage: { addListener: (f) => { handler = f; } },
        sendMessage: (m) => { broadcasts.push(m); return Promise.resolve(); },
        getPlatformInfo: (cb) => cb && cb({}), lastError: null },
      downloads: { onChanged: { addListener(){}, removeListener(){} },
        search: ({ query, id }) => Promise.resolve(id != null ? [finalState[id]]
          : history.filter((h) => h.includes(query[0])).map((h) => ({ filename: h }))),
        download: ({ url, filename }) => {
          if (failUrls.includes(url)) return Promise.reject(new Error('network failure'));
          started.push(filename);
          const queue = interrupts[url] || interrupts['*'];
          const reason = queue && (queue === interrupts['*'] ? queue[0] : queue.shift());
          finalState[started.length] = reason ? { state: 'interrupted', error: reason } : { state: 'complete' };
          return Promise.resolve(started.length);
        } },
      storage: { local: { set(){}, get: (keys, cb) => { const r = Object.fromEntries([].concat(keys || []).filter((k) => k in local).map((k) => [k, local[k]])); return cb ? cb(r) : Promise.resolve(r); }, remove: (keys) => { localRemoved.push(...keys); return Promise.resolve(); } },
        session: {
          get: (key) => Promise.resolve(key in session ? { [key]: JSON.parse(JSON.stringify(session[key])) } : {}),
          set: (obj) => { for (const [k, v] of Object.entries(obj)) session[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
          remove: (key) => { delete session[key]; return Promise.resolve(); },
        } },
      tabs: { query: (q, cb) => (cb ? cb([]) : Promise.resolve(openTabs.map((id) => ({ id })))),
        remove: (ids) => { removed.push(...ids); return Promise.resolve(); },
        sendMessage: () => Promise.resolve() },
      scripting: { executeScript: (options) => {
        scriptCalls.push(options);
        return Promise.resolve(scriptResult === undefined ? [] : [{ result: scriptResult }]);
      } } } };
  if (sidePanel) {
    s.chrome.sidePanel = {
      open: () => Promise.resolve(),
      setPanelBehavior: (b) => { panel.behavior.push(b); return sidePanel === 'ok' ? Promise.resolve() : Promise.reject(new Error('no side panel')); },
    };
    s.chrome.action = { setPopup: (p) => { panel.popups.push(p); return Promise.resolve(); } };
    s.chrome.runtime.onStartup = { addListener: (f) => panel.onStartup.push(f) };
  }
  s.self = s; vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/defaults.js'), 'utf8'), s, { filename: 'defaults.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/galleries.js'), 'utf8'), s, { filename: 'galleries.js' });
  for (const g of ['artstation', 'deviantart', 'pinterest']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, `src/galleries/${g}.js`), 'utf8'), s, { filename: `${g}.js` });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), s, { filename: 'background.js' });
  s.fetch = (url) => { fetched.push(url); return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(url) }); };
  // Send a command the way a panel does and wait for the (possibly async) reply.
  const ask = (message, sender = PANEL) => new Promise((resolve) => {
    const async = handler(message, sender, resolve);
    if (async !== true) setImmediate(() => resolve(undefined));
  });
  return {
    s, broadcasts, started, intervals, fetched, removed, localRemoved, scriptCalls, session, panel, ask,
    getHandler: () => handler,
  };
}

/* --------------------------------------------------------------- parsers */
// `fastTimers` resolves every setTimeout at once, for parsers that pace or
// back off between requests.
function loadParsers({ fastTimers = false } = {}) {
  const waits = [];
  const s = { console: { log(){}, warn(){}, error(){} }, URL, Math, Set, RegExp, Number,
    parseInt, parseFloat, encodeURIComponent, Promise, Array, waits,
    setTimeout: fastTimers ? (fn, ms) => { waits.push(ms); fn(); } : setTimeout,
    document: { hidden: false }, location: { href: 'https://x/', hostname: 'x' } };
  s.self = s; s.window = s; vm.createContext(s);
  for (const f of ['src/naming.js', 'src/galleries.js', 'src/galleries/artstation.js', 'src/galleries/deviantart.js', 'src/galleries/pinterest.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), s, { filename: f });
  }
  return s;
}

(async () => {
  const N = loadNaming();

  section('naming: DeviantArt stems and sibling codes');
  eq('parses a marked stem',
    N.parseArtworkStem('steampunk_world_of_astran_by_who_dmfgrtd-fullview', 'who'),
    { slug: 'steampunk_world_of_astran', author: 'who', hash: 'dmfgrtd', marker: '-fullview' });
  eq('-414w-2x parses', N.parseArtworkStem('a_b_by_who_dh7pkdy-414w-2x', 'who').marker, '-414w-2x');
  eq('non-artwork rejected', N.parseArtworkStem('dmfgrtd-9caa8bec-25dc', 'who'), null);
  eq('-pre, 5 images', N.siblingCodes('e', 4), ['f', 'g', 'h', 'k']);
  eq('-pre, 6 images', N.siblingCodes('e', 5), ['f', 'g', 'h', 'j', 'k']);
  eq('-pre, 7 images', N.siblingCodes('e', 6), ['f', 'g', 'a', 'b', 'c', 'd']);
  eq('-fullview', N.siblingCodes('w', 3), ['z', 'y', 'x']);
  eq('-2x', N.siblingCodes('x', 3), ['z', 'y', 'a']);
  eq('35 unique single codes', new Set(N.siblingCodes('w', 35)).size, 35);
  eq('video keeps its own name behind the author',
    N.buildDownloadNames([{ url: 'https://x/v/clip.mp4', kind: 'video' }],
      { pageUrl: 'https://www.deviantart.com/coolarts223/art/T-1' })[0].filename, 'coolarts223_clip.mp4');

  section('background: per-tab aggregation');
  const TAB = { id: 7, url: 'https://www.deviantart.com/a/art/B-1', title: 'Barn' };
  const PATHS = { images: 'PIC', videos: 'MOV' };
  const imgs = (n) => Array.from({ length: n }, (_, i) => ({ imageUrl: `https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u/img${i}.jpg`, filename: `img${i}.jpg` }));
  const lastRow = (b) => b.filter((m) => m.type === 'download-progress').map((m) => m.item).pop();

  let env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(6) }, PATHS, env.s.createThrottle(0), true, false);
  eq('6 fresh -> downloaded (6)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['downloaded', 6]);

  env = loadBackground({ history: ['/d/PIC/img0.jpg', '/d/PIC/img1.jpg', '/d/PIC/img2.jpg'] });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(3) }, PATHS, env.s.createThrottle(0), true, false);
  eq('all duplicates -> skipped (3)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['skipped', 3]);

  env = loadBackground({ failUrls: ['https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u/img0.jpg'] });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(1) }, PATHS, env.s.createThrottle(0), true, false);
  eq('failure -> error (1)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['error', 1]);

  section('background: paced downloads (Pinterest policy)');
  const POLICY = { awaitCompletion: true, minDelaySeconds: 1.5 };
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(3) }, PATHS, env.s.createThrottle(0), true, false, POLICY);
  eq('paced: all complete -> downloaded (3)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count, env.started.length], ['downloaded', 3, 3]);

  env = loadBackground({ interrupts: { 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u/img0.jpg': ['SERVER_FORBIDDEN'] } });
  let thr = env.s.createThrottle(0);
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(2) }, PATHS, thr, true, false, POLICY);
  eq('paced: refused once -> retried and downloaded', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count, env.started.length], ['downloaded', 2, 3]);

  env = loadBackground({ interrupts: { '*': ['NETWORK_FAILED'] } });
  thr = env.s.createThrottle(0);
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(8) }, PATHS, thr, true, false, POLICY);
  eq('paced: sustained refusal -> stops after 5 images x 3 attempts', env.started.length, 15);
  eq('paced: blocked tab is reported', [lastRow(env.broadcasts).status, /BLOCKED/.test(lastRow(env.broadcasts).filename)], ['error', true]);
  eq('paced: refusals slow the run down', thr.delaySeconds > 0, true);

  env = loadBackground({ interrupts: { '*': ['NETWORK_FAILED'] } });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(2) }, PATHS, env.s.createThrottle(0), true, false);
  eq('no policy: behaviour unchanged (no waiting, no retries)', env.started.length, 2);

  section('background: partial downloads');
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(5), unavailable: 3 }, PATHS, env.s.createThrottle(0), true, false);
  eq('progress counts undownloadable items too: Downloading (1/8) ... (5/8)',
    env.broadcasts.filter((m) => m.type === 'download-progress' && m.item.status === 'downloading')
      .map((m) => `${m.item.count}/${m.item.total}`), ['1/8', '2/8', '3/8', '4/8', '5/8']);
  eq('5 downloaded + 3 undownloadable -> Partial (5/8) with an explanation',
    [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count, lastRow(env.broadcasts).total, /YouTube/.test(lastRow(env.broadcasts).message)],
    ['partial', 5, 8, true]);
  env = loadBackground({ history: ['/d/PIC/img0.jpg'] });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(2), unavailable: 1 }, PATHS, env.s.createThrottle(0), true, false);
  eq('files already present count as got: Partial (2/3)',
    [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count, lastRow(env.broadcasts).total], ['partial', 2, 3]);
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(2) }, PATHS, env.s.createThrottle(0), true, false);
  eq('no undownloadable items -> plain Downloaded (2), as before',
    [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['downloaded', 2]);

  section('background: media filter (Images & videos / Only images / Only videos) and GIF folder');
  const WIXI = 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u';
  const mixed = [{ imageUrl: `${WIXI}/a.jpg`, filename: 'a.jpg' },
                 { imageUrl: 'https://wixmp-ed30a86b8c4ca887773594c2.wixmp.com/v/mp4/u/v.mp4', filename: 'clip.mp4' },
                 { imageUrl: `${WIXI}/g.gif`, filename: 'anim.gif' }];
  env = loadBackground();
  const kept = (kinds) => env.s.filterKinds(mixed, kinds).keep.map((i) => i.filename);
  eq('Images & videos: nothing dropped', [kept({}), env.s.filterKinds(mixed, {}).dropped], [['a.jpg', 'clip.mp4', 'anim.gif'], 0]);
  eq('Only images: the mp4 is dropped, a GIF is an image', kept({ skipVideos: true }), ['a.jpg', 'anim.gif']);
  eq('Only videos: images and the GIF are dropped', kept({ skipImages: true }), ['clip.mp4']);
  eq('GIF as video: counts as a video for the filter', [kept({ skipVideos: true, gifAsVideo: true }), kept({ skipImages: true, gifAsVideo: true })],
    [['a.jpg'], ['clip.mp4', 'anim.gif']]);
  eq('GIF folder: images path by default, videos path when switched on',
    [env.s.pickSubfolder('anim.gif', PATHS), env.s.pickSubfolder('anim.gif', PATHS, true), env.s.pickSubfolder('a.jpg', PATHS, true),
     env.s.pickSubfolder('clip.mp4', PATHS)], ['PIC', 'MOV', 'PIC', 'MOV']);
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: mixed }, PATHS, env.s.createThrottle(0), false, { skipVideos: true });
  eq('Only images: image and GIF download into PIC', env.started, ['PIC/a.jpg', 'PIC/anim.gif']);
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: mixed }, PATHS, env.s.createThrottle(0), false, { skipImages: true, gifAsVideo: true });
  eq('Only videos + GIF as video: clip and GIF download into MOV', env.started, ['MOV/clip.mp4', 'MOV/anim.gif']);
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: mixed.slice(0, 1) }, PATHS, env.s.createThrottle(0), false, { skipImages: true });
  eq('a tab with only filtered-out kinds is skipped with the reason', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).reason, env.started.length],
    ['skipped', 'images', 0]);

  section('background: messages, throttle, ETA, keepalive');
  env = loadBackground();
  let replied = null;
  eq('scan-all-tabs returns false', env.getHandler()({ command: 'scan-all-tabs' }, PANEL, (r) => { replied = r; }), false);
  eq('...and answers', replied, { status: 'started' });
  const t = env.s.createThrottle(0.5);
  eq('1st 429 -> 1.0s / 5s', [env.s.throttleHit(t, '429'), t.delaySeconds], [5000, 1.0]);
  eq('403 floors at 120s', env.s.throttleHit(env.s.createThrottle(0.5), '403', 120), 120000);
  eq('no ETA before 3 samples', env.s.projectFinish(Date.now() - 1000, 2, 100), 0);
  env.s.startKeepAlive();
  eq('keepalive every 20s', env.intervals[0].ms, 20000);
  env.s.stopKeepAlive();
  eq('keepalive cleared', env.intervals.length, 0);

  section('background: run log survives the panel closing');
  const row = (id, status, extra = {}) => ({ id, url: `https://x/${id}`, title: `T${id}`, status, ...extra });
  const session = {};
  env = loadBackground({ session });
  await env.ask({ command: 'get-run-state' });            // let the session restore settle
  env.s.setRunning(true);
  env.s.broadcast('download-progress', row(1, 'downloading', { count: 1, total: 3 }));
  env.s.broadcast('download-progress', row(1, 'downloaded', { count: 3, total: 3 }));
  env.s.broadcast('download-progress', row(2, 'scanning'));
  let snap = await env.ask({ command: 'get-run-state' });
  eq('reopened mid-run: rows and running flag come back',
    [snap.running, snap.rows.map((r) => [r.id, r.status, r.count])], [true, [[1, 'downloaded', 3], [2, 'scanning', undefined]]]);
  eq('the same tab updates its row instead of adding one', snap.rows.length, 2);

  eq('second Download while running is refused', await env.ask({ command: 'scan-all-tabs' }), { status: 'busy' });
  eq('...and the running run keeps its rows', (await env.ask({ command: 'get-run-state' })).rows.length, 2);

  // The browser unloads the background mid-run and starts a fresh one.
  let env2 = loadBackground({ session });
  snap = await env2.ask({ command: 'get-run-state' });
  eq('after a background restart: rows kept, run reported finished', [snap.running, snap.rows.length], [false, 2]);
  eq('...so Download works again', await env2.ask({ command: 'scan-all-tabs' }), { status: 'started' });

  env2 = loadBackground({ session: {} });
  eq('fresh browser session: empty log', await env2.ask({ command: 'get-run-state' }), { rows: [], running: false, startedAt: null });

  const s2 = {};
  env = loadBackground({ session: s2, openTabs: [1, 3] });
  await env.ask({ command: 'get-run-state' });
  env.s.setRunning(true);
  env.s.broadcast('download-progress', row(1, 'downloaded'));
  env.s.broadcast('download-progress', row(2, 'downloaded'));    // tab 2 was closed by the user meanwhile
  env.s.broadcast('download-progress', row(3, 'error'));
  env.s.setRunning(false);
  eq('Close downloaded tabs: closes only open, downloaded tabs', [await env.ask({ command: 'close-downloaded-tabs' }), env.removed],
    [{ status: 'closed', ids: [1, 2] }, [1]]);
  eq('...and the closed marks are stored', s2.runLog.rows.map((r) => !!r.closed), [true, true, false]);
  eq('...so a second press closes nothing', (await env.ask({ command: 'close-downloaded-tabs' })).ids, []);
  eq('Clear list erases the stored copy entirely', [await env.ask({ command: 'reset-log' }), 'runLog' in s2], [{ status: 'cleared' }, false]);
  eq('...and nothing is left for a reopened panel', await env.ask({ command: 'get-run-state' }), { rows: [], running: false, startedAt: null });
  eq('...even after a background restart', await loadBackground({ session: s2 }).ask({ command: 'get-run-state' }),
    { rows: [], running: false, startedAt: null });

  env.s.setRunning(true);
  env.s.broadcast('download-progress', row(5, 'downloading'));
  eq('Clear list is refused mid-run', [await env.ask({ command: 'reset-log' }), s2.runLog.rows.length], [{ status: 'busy' }, 1]);
  env.s.setRunning(false);

  eq('old unused run timestamps are removed from permanent storage',
    env.localRemoved, ['downloadInProgress', 'lastDownloadComplete']);

  env = loadBackground();
  await env.ask({ command: 'scan-all-tabs' });
  eq('a finished run releases the lock', (await env.ask({ command: 'get-run-state' })).running, false);

  section('settings: per gallery');
  env = loadBackground();
  const GS = env.s.GALLERY_SETTINGS;
  const DEF = { rateLimit: 0.5, skipDownloaded: true, preferPreview: false, gifAsVideo: false,
    expandGalleries: false, galleryPaginate: true, batchSize: 10 };
  eq('fresh install: every gallery starts from the same defaults',
    ['artstation.com', 'deviantart.com', 'pinterest.com'].map((g) => GS.forGallery({}, g)), [DEF, DEF, DEF]);
  const mixedStore = { skipDownloaded: false, gallerySettings: { 'pinterest.com': { expandGalleries: true } } };
  eq('a gallery\'s own value wins; values saved before 1.1.1 seed the rest; else the default', [
    GS.forGallery(mixedStore, 'pinterest.com'), GS.forGallery(mixedStore, 'deviantart.com')], [
    { ...DEF, skipDownloaded: false, expandGalleries: true }, { ...DEF, skipDownloaded: false }]);
  eq('own false/0 values are kept, not replaced by defaults',
    GS.forGallery({ gallerySettings: { 'deviantart.com': { skipDownloaded: false, rateLimit: 0 } } }, 'deviantart.com'),
    { ...DEF, skipDownloaded: false, rateLimit: 0 });

  const MF = env.s.MEDIA_FILTER;
  eq('media filter: fresh install is Images & videos; a saved choice is kept',
    [MF.resolve({}), MF.resolve({ mediaFilter: 'videos' }), MF.resolve({ mediaFilter: 'bogus' })], ['all', 'videos', 'all']);
  eq('media filter: a ticked 1.1.1 "Skip videos" for the selected gallery becomes Only images', [
    MF.resolve({ gallery: 'pinterest.com', gallerySettings: { 'pinterest.com': { skipVideos: true } } }),
    MF.resolve({ gallery: 'deviantart.com', gallerySettings: { 'pinterest.com': { skipVideos: true } } }),
    MF.resolve({ skipVideos: true }),
    MF.resolve({ mediaFilter: 'all', gallery: 'pinterest.com', gallerySettings: { 'pinterest.com': { skipVideos: true } } })],
    ['images', 'all', 'images', 'all']);

  const runArgs = async (local) => {
    const e = loadBackground({ local });
    let args = null;
    e.s.downloadImagesSequentially = (...a) => { args = a; return Promise.resolve(); };
    await e.ask({ command: 'scan-all-tabs' });
    await new Promise(setImmediate);
    // (tabs, folder, paths, rateLimit, gallery, maxDate, skipDownloaded, preferPreview, expand, paginate, batch, kinds)
    return args && args.slice(3);
  };
  const ALL = { skipImages: false, skipVideos: false, gifAsVideo: false };
  const perGalleryStore = { gallery: 'pinterest.com', mediaFilter: 'all', gallerySettings: {
    'pinterest.com': { rateLimit: 2, skipDownloaded: false, expandGalleries: true, gifAsVideo: true },
    'deviantart.com': { rateLimit: 1, preferPreview: true, batchSize: 3 } } };
  eq('a run uses the selected gallery\'s settings (Pinterest)', await runArgs(perGalleryStore),
    [2, 'pinterest.com', '', false, false, true, true, 10, { ...ALL, gifAsVideo: true }]);
  eq('...and switching the gallery switches them (DeviantArt)', await runArgs({ ...perGalleryStore, gallery: 'deviantart.com' }),
    [1, 'deviantart.com', '', true, true, false, true, 3, ALL]);
  eq('the toolbar media filter applies to every gallery', [
    (await runArgs({ ...perGalleryStore, mediaFilter: 'videos' }))[8],
    (await runArgs({ ...perGalleryStore, gallery: 'deviantart.com', mediaFilter: 'images' }))[8]],
    [{ skipImages: true, skipVideos: false, gifAsVideo: true }, { skipImages: false, skipVideos: true, gifAsVideo: false }]);
  eq('not yet migrated install: the old shared values still apply',
    await runArgs({ gallery: 'artstation.com', skipDownloaded: false, expandGalleries: true, skipVideos: true }),
    [0.5, 'artstation.com', '', false, false, true, true, 10, { ...ALL, skipVideos: true }]);

  section('background: toolbar icon - side panel primary, popup fallback');
  env = loadBackground({ sidePanel: 'ok' });
  await new Promise(setImmediate);
  eq('Chrome: icon opens the side panel, manifest popup removed',
    [env.panel.behavior, env.panel.popups], [[{ openPanelOnActionClick: true }], [{ popup: '' }]]);
  eq('Chrome: re-applied when the browser starts', env.panel.onStartup.length, 1);
  env = loadBackground({ sidePanel: 'fails' });
  await new Promise(setImmediate);
  eq('side panel API rejects: popup kept', env.panel.popups, []);
  env = loadBackground();
  eq('Yandex / Opera (no side panel API): popup kept, nothing changed', env.panel, { behavior: [], popups: [], onStartup: [] });

  section('background: Chromium same-origin page fetch bridge');
  const pageReply = { ok: true, status: 200, body: '{"assets":[]}' };
  env = loadBackground({ scriptResult: pageReply });
  eq('page fetch returns MAIN-world result to content script',
    await env.ask({ command: 'page-fetch', url: 'https://www.artstation.com/projects/ABC.json' }, { id: EXT_ID, tab: { id: 42, url: 'https://www.artstation.com/artwork/ABC' } }),
    pageReply);
  eq('page fetch executes in sender tab MAIN world with requested URL',
    [env.scriptCalls[0].target, env.scriptCalls[0].world, env.scriptCalls[0].args],
    [{ tabId: 42 }, 'MAIN', ['https://www.artstation.com/projects/ABC.json', {}]]);
  eq('page fetch from the panel (no sender tab) is refused',
    await env.ask({ command: 'page-fetch', url: 'https://www.artstation.com/projects/ABC.json' }),
    { error: 'Command not allowed from this sender' });
  const stateReply = { '@@entities': { deviation: {} } };
  env = loadBackground({ scriptResult: stateReply });
  eq('page state returns whitelisted MAIN-world state',
    await env.ask({ command: 'page-state' }, { id: EXT_ID, tab: { id: 7, url: 'https://www.deviantart.com/a/art/B-1' } }), { state: stateReply });
  eq('page state executes in sender tab MAIN world',
    [env.scriptCalls[0].target, env.scriptCalls[0].world], [{ tabId: 7 }, 'MAIN']);
  eq('page state from the panel (no sender tab) is refused', await env.ask({ command: 'page-state' }),
    { error: 'Command not allowed from this sender' });

  section('security: media host allow-list, filenames, senders');
  env = loadBackground();
  const allowed = (url, domain) => env.s.isAllowedMediaUrl(url, domain);
  eq('real gallery media hosts are allowed for their own gallery', [
    allowed('https://cdna.artstation.com/p/assets/images/images/001/4k/a.jpg', 'artstation.com'),
    allowed('https://cdn.artstation.com/p/video_sources/002/000/980/clip.mp4', 'artstation.com'),
    allowed('https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u/a.jpg?token=t', 'deviantart.com'),
    allowed('https://wixmp-ed30a86b8c4ca887773594c2.wixmp.com/v/mp4/u/d.VideoQualities.res_720p.x.mp4', 'deviantart.com'),
    allowed('https://i.pinimg.com/736x/ca/56/4f/a.jpg', 'pinterest.com'),
    allowed('https://i.pinimg.com/videos/x/a.mp4', 'pinterest.com'),
    allowed('https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/a_720w.mp4', 'pinterest.com'),
  ], [true, true, true, true, true, true, true]);
  eq('rejected: other hosts, other galleries, http, credentials, ports, lookalikes', [
    allowed('https://evil.example/x?.pinimg.com/videos/a.mp4', 'pinterest.com'),
    allowed('https://pinimg.com.evil.example/videos/a.mp4', 'pinterest.com'),
    allowed('https://i.pinimg.com@evil.example/a.jpg', 'pinterest.com'),
    allowed('https://notpinimg.com/a.jpg', 'pinterest.com'),
    allowed('http://i.pinimg.com/736x/a.jpg', 'pinterest.com'),
    allowed('https://i.pinimg.com:8443/736x/a.jpg', 'pinterest.com'),
    allowed('https://cdna.artstation.com/p/a.jpg', 'pinterest.com'),
    allowed('https://192.168.1.1/a.jpg', 'deviantart.com'),
    allowed('javascript:alert(1)', 'deviantart.com'),
    allowed('https://i.pinimg.com/736x/a.jpg', null) && allowed('https://i.pinimg.com/736x/a.jpg', 'example.com'),
  ], [false, false, false, false, false, false, false, false, false, false]);

  const PIN_TAB = { id: 9, url: 'https://es.pinterest.com/pin/1/', title: 'Pin' };
  env = loadBackground();
  await env.s.downloadTabImages(PIN_TAB, { title: 'x', images: [
    { imageUrl: 'https://evil.example/x?.pinimg.com/videos/a.mp4', filename: 'a.mp4' },
    { imageUrl: 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/a_720w.mp4', filename: 'b.mp4' },
  ] }, PATHS, env.s.createThrottle(0), false, false);
  eq('the moderator\'s URL is never requested; the real video still downloads',
    [env.started, lastRow(env.broadcasts).status], [['MOV/b.mp4'], 'downloaded']);
  eq('blocked item is not shown as a thumbnail',
    env.broadcasts.some((m) => /evil/.test(m.item?.thumbUrl || '')), false);
  eq('downloadImage refuses a non-gallery URL with a clear message',
    await env.s.downloadImage('https://evil.example/a.jpg', 'a.jpg', 'PIC', false, 'pinterest.com'),
    { status: 'error', message: 'blocked: not a gallery media URL' });
  eq('downloadImage refuses when the gallery is unknown',
    (await env.s.downloadImage('https://i.pinimg.com/736x/a.jpg', 'a.jpg', 'PIC', false, null)).status, 'error');
  eq('nothing reached the browser downloader', env.started.length, 1);

  eq('filenames: folders, traversal and executables neutralised', [
    env.s.safeMediaFilename('../../evil.exe'),
    env.s.safeMediaFilename('a/b\\c.mp4'),
    env.s.safeMediaFilename('.hidden.png'),
    env.s.safeMediaFilename('art.svg'),
    env.s.safeMediaFilename('clip.MP4'),
  ], ['evil.exe.jpg', 'a_b_c.mp4', 'hidden.png', 'art.svg.jpg', 'clip.MP4']);
  eq('panel thumbnails only from gallery media hosts',
    [env.s.logItem(TAB, 'x', { thumbUrl: 'https://evil.example/t.jpg' }).thumbUrl,
     env.s.logItem(TAB, 'x', { thumbUrl: 'https://i.pinimg.com/236x/t.jpg' }).thumbUrl],
    ['', 'https://i.pinimg.com/236x/t.jpg']);

  const contentSender = { id: EXT_ID, tab: { id: 3, url: 'https://www.deviantart.com/a/art/B-1' } };
  const refused = { error: 'Command not allowed from this sender' };
  env = loadBackground();
  eq('panel commands are refused from a content script', [
    await env.ask({ command: 'scan-all-tabs' }, contentSender),
    await env.ask({ command: 'reset-log' }, contentSender),
    await env.ask({ command: 'close-downloaded-tabs' }, contentSender),
    await env.ask({ command: 'stop-scan' }, contentSender),
    await env.ask({ command: 'get-run-state' }, contentSender),
  ], [refused, refused, refused, refused, refused]);
  eq('...and from another extension', await env.ask({ command: 'scan-all-tabs' }, { id: 'other@ext' }), refused);
  eq('page commands are refused from a non-gallery tab', [
    await env.ask({ command: 'page-fetch', url: 'https://example.com/' }, { id: EXT_ID, tab: { id: 4, url: 'https://example.com/' } }),
    await env.ask({ command: 'page-state' }, { id: 'other@ext', tab: { id: 5, url: 'https://www.deviantart.com/' } }),
  ], [refused, refused]);
  eq('no script ran for a refused command', env.scriptCalls.length, 0);

  env = loadBackground();
  await env.s.downloadIndexTab({ id: 1, url: 'https://www.deviantart.com/a/gallery', title: 'G' },
    ['http://www.deviantart.com/a/art/W-1', 'https://evil.example/a/art/W-2', 'https://192.168.1.1/a/art/W-3',
     'https://www.deviantart.com/a/art/W-4'],
    { parser: { parseDeviationHtml: () => ({ images: [] }) }, galleryPath: PATHS, throttle: env.s.createThrottle(0),
      skipDownloaded: false, preferPreview: false, batchSize: 5 });
  eq('gallery pages are fetched only over https from the gallery itself', env.fetched, ['https://www.deviantart.com/a/art/W-4']);

  section('background: date cutoff early stop');
  const day = (n) => `2026-08-${String(n).padStart(2, '0')}`;
  const dates = Array.from({ length: 30 }, (_, i) => day(30 - i));
  const parser = { parseDeviationHtml: (html) => {
    const i = Number(html.split('#')[1]);
    return { images: [{ imageUrl: `https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/u/${i}.jpg`, filename: `img${i}.jpg` }], title: `D${i}`, pageDate: dates[i] };
  } };
  const links = dates.map((_, i) => `https://www.deviantart.com/a/art/W-${i}#${i}`);
  const runIndex = (e, ctx) => e.s.downloadIndexTab({ id: 1, url: 'https://www.deviantart.com/a/gallery', title: 'G' }, links, {
    parser, galleryPath: PATHS, throttle: e.s.createThrottle(0),
    skipDownloaded: false, preferPreview: false, batchSize: 5, ...ctx });

  env = loadBackground();
  await runIndex(env, { maxDate: '2026-08-27', sortOrder: 'newest' });
  eq('downloads only on/after the cutoff', env.started.length, 4);
  eq('stops early instead of walking all 30', env.fetched.length, 10);
  eq('the row explains the stop', /reached the 2026-08-27 cutoff/.test(lastRow(env.broadcasts).filename), true);

  for (const [label, ctx] of [['oldest-first', { maxDate: '2026-08-27', sortOrder: 'oldest' }],
                              ['unknown order', { maxDate: '2026-08-27', sortOrder: null }],
                              ['no cutoff', { sortOrder: 'newest' }]]) {
    env = loadBackground();
    await runIndex(env, ctx);
    eq(`${label}: walks the whole list`, env.fetched.length, 30);
  }
  env = loadBackground();
  await env.s.downloadIndexTab({ id: 1, url: 'https://www.deviantart.com/a/gallery', title: 'G' }, links.slice(0, 2), {
    parser: { parseDeviationHtml: () => null }, galleryPath: PATHS, throttle: env.s.createThrottle(0),
    skipDownloaded: false, preferPreview: false, batchSize: 5 });
  eq('a failed gallery row says why', [lastRow(env.broadcasts).status,
    /2 failed \(could not read the deviation data/.test(lastRow(env.broadcasts).filename)], ['error', true]);

  eq('shiftDate crosses months', env.s.shiftDate('2026-08-01', -1), '2026-07-31');
  eq('shiftDate handles leap days', env.s.shiftDate('2028-03-01', -1), '2028-02-29');

  section('parsers: index detection and search handling');
  const parsers = loadParsers();
  eq('only maintained galleries are registered', Object.keys(parsers.GALLERY_PARSERS).sort(),
    ['artstation.com', 'deviantart.com', 'pinterest.com']);
  const P = parsers.GALLERY_PARSERS['deviantart.com'];
  eq('gallery is an index', P.isIndexView('www.deviantart.com', '/a/gallery/all'), true);
  eq('a deviation is not', P.isIndexView('www.deviantart.com', '/a/art/B-1'), false);
  const mkDoc = (state, anchors = []) => ({
    documentElement: { outerHTML: `<script>window.__INITIAL_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify(state))});</script>` },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('a[href') ? anchors.map((href) => ({ href })) : []),
  });
  const galleryState = { gallectionSection: { selectedFolderId: -1, sortOrder: 'newest' },
    '@@entities': { galleryFolder: { '-1': { folderId: -1, name: 'All', size: 245 } }, deviation: {} }, '@@streams': {} };
  eq('reads the folder total', P.expectedIndexTotal(mkDoc(galleryState), 'https://www.deviantart.com/a/gallery/all'), 245);
  eq('reads the sort order', P.indexSortOrder(mkDoc(galleryState), 'https://www.deviantart.com/a/gallery/all'), 'newest');
  eq('URL order wins', P.indexSortOrder(mkDoc(galleryState), 'https://www.deviantart.com/a/gallery/all?order=oldest'), 'oldest');
  eq('a search reports no folder total',
    P.expectedIndexTotal(mkDoc(galleryState), 'https://www.deviantart.com/a/gallery/all?q=x'), null);
  eq('a search reports its term',
    P.indexSearchTerm(mkDoc(galleryState), 'https://www.deviantart.com/a/gallery?q=steampunk+truck'), 'steampunk truck');

  // Real title slugs from a gallery that stalled at 9/15: dots and
  // percent-escaped punctuation must not drop a deviation.
  const slugs = ['Field-Work-1387976438', 'Earth-never-stood-a-chance...-1387520503',
    'For-the-Mines%2C-or-for-the-Arena-1380093459', 'Perhaps-space-exploration-wasn%27t-such-a-great-idea....-1364725210'];
  const slugAnchors = [...slugs.map((s) => `https://www.deviantart.com/a/art/${s}`),
    'https://www.deviantart.com/someoneelse/art/Theirs-1', 'https://www.deviantart.com/a/art/No-Id',
    'https://www.deviantart.com/a/art/Has-Query-5?x=1'];
  eq('every owned deviation link is collected, whatever its title punctuation',
    (await P.extractIndexLinks(mkDoc(galleryState, slugAnchors), 'https://www.deviantart.com/a/gallery/all', { paginate: false })).length, 4);

  const daHref = 'https://www.deviantart.com/artist/art/Work-123';
  const daFull = 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/abc/work.jpg';
  const daState = { '@@entities': {
    deviationExtended: { '123': { additionalMedia: [] } },
    deviation: { '123': { title: 'Work', author: 'u1', url: daHref,
      media: { baseUri: daFull, prettyName: 'work', types: [{ t: 'fullview', c: '', r: 0 }], token: [] } } },
    user: { u1: { username: 'artist' } },
  } };
  parsers.__BI_PAGE_STATE__ = async () => daState;
  const noEmbeddedStateDoc = { documentElement: { outerHTML: '' }, images: [], querySelector: () => null };
  eq('Opera MAIN-world state bridge returns real DeviantArt media',
    (await P.extractImageUrls(noEmbeddedStateDoc, daHref)).map((i) => i.imageUrl), [daFull]);

  parsers.__BI_PAGE_STATE__ = async () => null;
  const daPlaceholder = { src: 'https://st.deviantart.net/default1200x630.png', clientWidth: 1200, clientHeight: 630 };
  const daSmall = { src: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/abc/small.jpg', clientWidth: 200, clientHeight: 100 };
  const daMain = { src: daFull, clientWidth: 900, clientHeight: 600, alt: 'Work' };
  const renderedDaDoc = { documentElement: { outerHTML: '' }, images: [daPlaceholder, daSmall, daMain], querySelector: () => null };
  eq('Opera missing state -> largest rendered wixmp artwork, placeholder rejected',
    (await P.extractImageUrls(renderedDaDoc, daHref)).map((i) => i.imageUrl), [daFull]);
  eq('DeviantArt disables content.js generic Open Graph fallback', P.disableGenericFallback, true);

  // In-page navigation: the tab first loaded deviation 999, then moved to 123.
  const daStale = JSON.parse(JSON.stringify(daState));
  daStale['@@entities'].deviationExtended = { '999': { additionalMedia: [] } };
  daStale['@@entities'].deviation = { '999': { ...daState['@@entities'].deviation['123'],
    media: { ...daState['@@entities'].deviation['123'].media, baseUri: 'https://images-wixmp-x.wixmp.com/f/old/old.jpg' } } };
  const freshHtml = mkDoc(daState).documentElement.outerHTML;
  const fetched123 = [];
  const freshFetch = (url) => { fetched123.push(url); return Promise.resolve({ ok: true, text: () => Promise.resolve(freshHtml) }); };
  eq('stale state after in-page navigation -> current page fetched, never the old deviation',
    [(await P.extractImageUrls(mkDoc(daStale), daHref, { fetch: freshFetch })).map((i) => i.imageUrl), fetched123],
    [[daFull], [daHref]]);
  eq('stale state and page fetch fails -> rendered artwork, not the old deviation',
    (await P.extractImageUrls({ ...mkDoc(daStale), images: [daPlaceholder, daMain] }, daHref,
      { fetch: () => Promise.resolve({ ok: false, status: 500 }) })).map((i) => i.imageUrl), [daFull]);
  eq('fetched deviation pages still parse by their own id',
    P.parseDeviationHtml(freshHtml, daHref).images.map((i) => i.imageUrl), [daFull]);

  // A background that never answers (e.g. an older one still running after
  // the files were updated) must degrade to the next fallback, not an error.
  parsers.__BI_PAGE_STATE__ = () => Promise.reject(new Error('The message port closed before a response was received.'));
  let threw = null;
  let viaFetch = [];
  try {
    viaFetch = await P.extractImageUrls(noEmbeddedStateDoc, daHref, { fetch: freshFetch });
  } catch (error) { threw = error.message; }
  eq('state bridge rejects -> no error, current page fetched instead', [threw, viaFetch.map((i) => i.imageUrl)], [null, [daFull]]);
  delete parsers.__BI_PAGE_STATE__;

  // content.js defines the Chromium bridges only where there is no `browser`
  // global, and they swallow an unanswered message.
  const loadContent = (withBrowser, sendMessage) => {
    const c = { console: { log() {}, warn() {}, error() {} }, URL, Promise, Error, JSON,
      location: { href: 'https://www.deviantart.com/a/art/B-1', hostname: 'www.deviantart.com', origin: 'https://www.deviantart.com' },
      document: { querySelector: () => null, images: [] },
      fetch: (url) => Promise.resolve({ ok: true, status: 200, direct: url }),
      chrome: { runtime: { sendMessage, onMessage: { addListener() {} } } } };
    if (withBrowser) c.browser = c.chrome;
    c.self = c; vm.createContext(c);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8'), c, { filename: 'content.js' });
    return c;
  };
  const rejecting = () => Promise.reject(new Error('Could not establish connection.'));
  eq('Firefox: no Chromium bridges defined',
    [typeof loadContent(true, rejecting).__BI_PAGE_STATE__, typeof loadContent(true, rejecting).__BI_PAGE_FETCH__], ['undefined', 'undefined']);
  const chromium = loadContent(false, rejecting);
  eq('Chromium: unanswered page-state -> null, not a throw', await chromium.__BI_PAGE_STATE__(), null);
  eq('Chromium: unanswered page-fetch -> direct fetch, not a throw',
    (await chromium.__BI_PAGE_FETCH__('https://www.deviantart.com/x')).direct, 'https://www.deviantart.com/x');
  const fetchError = async (c, url) => { try { await c.__BI_PAGE_FETCH__(url); return null; } catch (e) { return e.message; } };
  eq('Chromium: unanswered page-fetch never falls back to another origin',
    await fetchError(chromium, 'http://192.168.1.1/admin'), 'Cross-origin page fetch rejected');
  const refusing = loadContent(false, () => Promise.resolve({ error: 'Cross-origin page fetch rejected' }));
  eq('Chromium: a page-fetch the background rejected is final (no direct-fetch fallback)',
    await fetchError(refusing, 'https://evil.example/x'), 'Cross-origin page fetch rejected');

  const pinterest = loadParsers().GALLERY_PARSERS['pinterest.com'];
  eq('pinterest pin is a main view', pinterest.isMainImageView('es.pinterest.com', '/pin/123/'), true);

  function mkPinDoc({ og, closeup, images = [], videos = [], html = '' }) {
    return {
      title: 'Nice pin | Pinterest',
      querySelector: (sel) => {
        if (sel === "meta[property='og:image']" && og) {
          return { getAttribute: () => og };
        }
        if (sel === '[data-test-id="pin-closeup-image"]' && closeup) {
          return { tagName: 'DIV', querySelector: () => closeup };
        }
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel === 'video') return videos;
        return [];
      },
      images,
      documentElement: { outerHTML: html },
    };
  }

  // 1. Video / animated pins win over og:image; multiple quality variants of
  //    the same video are collapsed to the best one.
  const videoHtml = '<html><head><meta property="og:image" content="https://i.pinimg.com/736x/00/00/00/poster.jpg"></head><body>'
    + 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_360w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4'
    + '</body></html>';
  const videoPinDoc = mkPinDoc({ html: videoHtml, og: 'https://i.pinimg.com/736x/00/00/00/poster.jpg' });
  eq('video pin prefers expMp4 720w over poster image',
    (await pinterest.extractImageUrls(videoPinDoc, 'https://www.pinterest.com/pin/456/')).map((i) => ({ url: i.imageUrl, kind: i.kind })),
    [{ url: 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4', kind: 'video' }]);

  // 1b. Same video offered in multiple codecs/sizes collapses to one best URL.
  const codecVariantsHtml = '<html><body>'
    + 'https://v1.pinimg.com/videos/iht/hevcMp4V3/5b/5d/0f/hash123_360w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/hevcMp4V4/5b/5d/0f/hash123_240w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/5b/5d/0f/hash123_720w.mp4'
    + '</body></html>';
  const codecPinDoc = mkPinDoc({ html: codecVariantsHtml, og: 'https://i.pinimg.com/736x/00/00/00/poster.jpg' });
  eq('single video with multiple codec/size variants returns one best URL',
    (await pinterest.extractImageUrls(codecPinDoc, 'https://www.pinterest.com/pin/111/')).map((i) => i.imageUrl),
    ['https://v1.pinimg.com/videos/iht/expMp4/5b/5d/0f/hash123_720w.mp4']);

  // 1c. Multiple distinct videos are returned (one best-quality item each).
  const multiVideoHtml = '<html><body>'
    + 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_360w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/a1/b2/c3/abc123_480w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/a1/b2/c3/abc123_720w.mp4'
    + '</body></html>';
  const multiVideoPinDoc = mkPinDoc({ html: multiVideoHtml, og: 'https://i.pinimg.com/736x/00/00/00/poster.jpg' });
  eq('multi-video pin returns best quality for each distinct video',
    (await pinterest.extractImageUrls(multiVideoPinDoc, 'https://www.pinterest.com/pin/789/')).map((i) => i.imageUrl).sort(),
    ['https://v1.pinimg.com/videos/iht/expMp4/a1/b2/c3/abc123_720w.mp4', 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4']);

  // 2. og:image is used for static pins.
  const ogPin = mkPinDoc({ og: 'https://i.pinimg.com/736x/00/00/00/og.jpg', closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/dom.jpg', src: 'https://i.pinimg.com/736x/00/00/00/dom.jpg' } });
  eq('og:image wins over closeup selector for static pin',
    (await pinterest.extractImageUrls(ogPin, 'https://www.pinterest.com/pin/123/')).map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/og.jpg']);

  // 3. Live DOM closeup hook is a fallback when og:image is missing.
  const hookPin = mkPinDoc({ closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/dom.jpg', src: 'https://i.pinimg.com/736x/00/00/00/dom.jpg' } });
  eq('closeup hook fallback works',
    (await pinterest.extractImageUrls(hookPin, 'https://www.pinterest.com/pin/123/')).map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/dom.jpg']);

  // 4. Non-pinimg URLs are rejected and fall back to the next source.
  const badOgPin = mkPinDoc({ og: 'https://evil.com/img.jpg', closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/good.jpg', src: 'https://i.pinimg.com/736x/00/00/00/good.jpg' } });
  eq('non-pinimg og:image is ignored',
    (await pinterest.extractImageUrls(badOgPin, 'https://www.pinterest.com/pin/123/')).map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/good.jpg']);

  // 5. Largest visible image fallback.
  const largestPinDoc = {
    title: 'Nice pin | Pinterest',
    querySelector: () => null,
    querySelectorAll: () => [],
    images: [
      { currentSrc: 'https://i.pinimg.com/236x/00/00/00/tiny.jpg', src: 'https://i.pinimg.com/236x/00/00/00/tiny.jpg', naturalWidth: 200, naturalHeight: 200 },
      { currentSrc: 'https://i.pinimg.com/736x/00/00/00/big.jpg', src: 'https://i.pinimg.com/736x/00/00/00/big.jpg', naturalWidth: 800, naturalHeight: 600 },
    ],
    documentElement: { outerHTML: '' },
  };
  eq('largest visible image fallback',
    (await pinterest.extractImageUrls(largestPinDoc, 'https://www.pinterest.com/pin/123/')).map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/big.jpg']);

  // Board/profile pages are now treated as indexes.
  eq('pinterest board is an index view', pinterest.isIndexView('www.pinterest.com', '/someuser/wallpapers/'), true);
  eq('pinterest profile is an index view', pinterest.isIndexView('www.pinterest.com', '/someuser/'), true);
  eq('pinterest pin is not an index view', pinterest.isIndexView('www.pinterest.com', '/pin/123/'), false);

  // Board grid images are extracted directly from document.images in document
  // order, stopping before the "more ideas" / "más ideas" separator.
  const boardImg1 = {
    currentSrc: 'https://i.pinimg.com/236x/aa/aa/aa/pin1.jpg',
    src: 'https://i.pinimg.com/236x/aa/aa/aa/pin1.jpg',
    tagName: 'IMG',
    alt: 'Pin 1',
    naturalWidth: 236,
    naturalHeight: 354,
  };
  const boardImg2 = {
    currentSrc: 'https://i.pinimg.com/236x/bb/bb/bb/pin2.jpg',
    src: 'https://i.pinimg.com/236x/bb/bb/bb/pin2.jpg',
    tagName: 'IMG',
    alt: 'Pin 2',
    naturalWidth: 236,
    naturalHeight: 354,
  };
  const smallAvatar = {
    currentSrc: 'https://i.pinimg.com/75x75_RS/aa/aa/aa/avatar.jpg',
    src: 'https://i.pinimg.com/75x75_RS/aa/aa/aa/avatar.jpg',
    tagName: 'IMG',
    alt: 'Avatar',
    naturalWidth: 75,
    naturalHeight: 75,
  };
  const moreIdeasHeading = {
    tagName: 'H2',
    textContent: 'Busca más ideas',
    getAttribute: () => null,
  };

  const boardDoc = {
    title: 'Chronicle | Pinterest',
    querySelector: (sel) => {
      if (sel === '[data-test-id="more-ideas-container"]') return null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'h1, h2, h3, h4, span, div, p') return [moreIdeasHeading];
      return [];
    },
    images: [smallAvatar, boardImg1, boardImg2],
  };
  const boardResult = (await pinterest.extractIndexLinks(boardDoc, 'https://www.pinterest.com/someuser/wallpapers/', {}));
  eq('board page extracts large pinimg images before more-ideas heading',
    boardResult && boardResult.images ? boardResult.images.map((i) => i.imageUrl) : [],
    ['https://i.pinimg.com/736x/aa/aa/aa/pin1.jpg', 'https://i.pinimg.com/736x/bb/bb/bb/pin2.jpg']);

  // A page wrapper whose textContent includes the heading must not be taken as
  // the separator (it contains every image, which would exclude them all).
  const wrapperDiv = { tagName: 'DIV', textContent: 'Chronicle 7 Pines ... Busca más ideas ...', children: [moreIdeasHeading] };
  const wrapperDoc = {
    ...boardDoc,
    querySelectorAll: (sel) => (sel.includes('div') ? [wrapperDiv, moreIdeasHeading] : []),
  };
  eq('page wrapper containing "más ideas" text is not used as separator',
    ((await pinterest.extractIndexLinks(wrapperDoc, 'https://www.pinterest.com/someuser/wallpapers/', {})).images || []).length, 2);

  section('parsers: ArtStation');
  // Shapes mirror real /projects/{hash}.json, /users/{name}/projects.json and
  // video_clip player pages; names and ids are made up.
  const AS = 'https://www.artstation.com';
  const CDN = 'https://cdna.artstation.com/p/assets';
  const clipEmbed = `${AS}/api/v2/animation/video_clips/1111-aaaa/embed.html?s=sig&t=1`;
  const asProject = (hash, published, assets) => ({
    hash_id: hash, title: `Title ${hash}`, published_at: `${published}T10:00:00.000-05:00`,
    user: { username: 'someartist' }, assets,
  });
  const asImage = (id) => ({ asset_type: 'image', has_image: true, id,
    image_url: `${CDN}/images/images/000/000/${id}/large/someartist-pic${id}.jpg?1700000000` });
  const multi = asProject('MULTI1', '2024-10-08', [
    asImage(1),
    { asset_type: 'cover', has_image: false, id: 2, image_url: `${CDN}/covers/images/000/000/002/large/sq.jpg?1` },
    { asset_type: 'video_clip', has_image: true, id: 3, image_url: `${CDN}/video_clips/images/thumb.jpg?1`,
      player_embedded: `<iframe src='${clipEmbed}' width='2000' height='1000' frameborder='0'></iframe>` },
    { asset_type: 'video', has_image: true, id: 4, image_url: `${CDN}/x/thumb.jpg?1`,
      player_embedded: "<iframe src='https://www.youtube.com/embed/xyz'></iframe>" },
    asImage(5),
  ]);
  const clipPage = '<video id="video" poster="p.jpg">'
    + '<source media="(min-width: 1000px)" src="https://cdn.artstation.com/p/video_sources/002/000/980/clip.mp4" type="video/mp4" />'
    + '<source media="(min-width: 0px)" src="https://cdn.artstation.com/p/video_sources/002/000/967/clip.mp4" type="video/mp4" />'
    + '</video>';
  // Fake fetch over a URL -> body table; a function body yields per-call statuses.
  const asFetch = (table, log = []) => (url) => {
    log.push(url);
    let body = table[url];
    if (typeof body === 'function') body = body();
    if (body === undefined || typeof body === 'number') {
      return Promise.resolve({ ok: false, status: body || 404 });
    }
    return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve(body), text: () => Promise.resolve(body) });
  };
  const asDoc = (og, assets = []) => ({
    querySelector: (sel) => (sel.includes('og:image') && og ? { getAttribute: () => og } : null),
    querySelectorAll: (sel) => (sel === 'project-asset' ? assets : []),
  });
  const renderedAsset = (images = [], videos = []) => ({
    querySelectorAll: (sel) => {
      if (sel === 'img') return images.map((url) => ({ currentSrc: url, src: url, alt: '' }));
      if (sel === 'video source[src], video[src]') return videos.map((url) => ({ src: url, title: '' }));
      return [];
    },
  });

  let asParsers = loadParsers({ fastTimers: true });
  const artstation = asParsers.GALLERY_PARSERS['artstation.com'];
  eq('artwork page is a main view', artstation.isMainImageView('www.artstation.com', '/artwork/MULTI1'), true);
  eq('artist profile is an index view', artstation.isIndexView('www.artstation.com', '/someartist'), true);
  eq('site sections are not profiles', ['/search', '/learning/', '/artwork/MULTI1', '/marketplace']
    .map((p) => artstation.isIndexView('www.artstation.com', p)), [false, false, false, false]);

  const asTable = { [`${AS}/projects/MULTI1.json`]: multi, [clipEmbed]: clipPage };
  const multiItems = await artstation.extractImageUrls(asDoc(null), `${AS}/artwork/MULTI1`, { fetch: asFetch(asTable) });
  eq('multi-asset artwork: 4k images in order, cover and external video skipped, best clip source',
    multiItems.map((i) => [i.kind, i.imageUrl]), [
      ['image', `${CDN}/images/images/000/000/1/4k/someartist-pic1.jpg?1700000000`],
      ['video', 'https://cdn.artstation.com/p/video_sources/002/000/980/clip.mp4'],
      ['image', `${CDN}/images/images/000/000/5/4k/someartist-pic5.jpg?1700000000`],
    ]);
  eq('clip gets a unique filename (asset id + name); the artist is reported separately',
    [multiItems[1].filename, multiItems.map((i) => i.author)], ['3_clip.mp4', ['someartist', 'someartist', 'someartist']]);
  eq('artwork carries its published date', multiItems[0].pageDate, '2024-10-08');

  const genericShare = 'https://www.artstation.com/assets/share-explore.jpg';
  const rendered1 = `${CDN}/images/images/000/000/101/large/someartist-one.jpg?1`;
  const rendered2 = `${CDN}/images/images/000/000/102/medium/someartist-two.jpg?2`;
  const renderedVideo = 'https://cdn.artstation.com/p/video_sources/002/000/999/clip.mp4';
  eq('JSON blocked in Opera -> rendered project assets, never generic share image',
    (await artstation.extractImageUrls(
      asDoc(genericShare, [renderedAsset([rendered1, rendered2], [renderedVideo])]),
      `${AS}/artwork/GONE`, { fetch: asFetch({}) },
    )).map((i) => [i.kind, i.imageUrl]), [
      ['image', rendered1.replace('/large/', '/4k/')],
      ['image', rendered2.replace('/medium/', '/4k/')],
      ['video', renderedVideo],
    ]);
  eq('generic ArtStation og:image is rejected when no project asset rendered',
    await artstation.extractImageUrls(asDoc(genericShare), `${AS}/artwork/GONE`, { fetch: asFetch({}) }), []);
  const validOg = `${CDN}/images/images/000/000/103/large/someartist-three.jpg?v=3`;
  eq('real artwork og:image remains a safe last resort',
    (await artstation.extractImageUrls(asDoc(validOg), `${AS}/artwork/GONE`, { fetch: asFetch({}) }))
      .map((i) => i.imageUrl), [validOg.replace('/large/', '/4k/')]);
  eq('ArtStation disables content.js generic og/image fallbacks', artstation.disableGenericFallback, true);

  // A project whose only content is a YouTube embed: nothing to download, and
  // the row says why instead of "no image found".
  const ytAsset = { asset_type: 'video', has_image: true, has_embedded_player: true, id: 77,
    image_url: `${CDN}/covers/images/000/000/077/large/yt-thumb.jpg?1`,
    player_embedded: "<iframe src='https://www.youtube.com/embed/abc'></iframe>" };
  const ytOnly = { [`${AS}/projects/YT1.json`]: asProject('YT1', '2025-01-01', [ytAsset]) };
  const ytItems = await artstation.extractImageUrls(
    asDoc(genericShare, [renderedAsset([rendered1])]), `${AS}/artwork/YT1`, { fetch: asFetch(ytOnly) });
  eq('YouTube-only project -> no files, not even a guess from the page', ytItems, []);
  eq('...and 1 undownloadable item is reported', artstation.unavailableCount(), 1);
  const ytMixed = { [`${AS}/projects/YT2.json`]: asProject('YT2', '2025-01-01', [asImage(88), ytAsset]) };
  eq('project with an image and a YouTube embed -> image downloaded, 1 unavailable',
    [(await artstation.extractImageUrls(asDoc(null), `${AS}/artwork/YT2`, { fetch: asFetch(ytMixed) })).length,
      artstation.unavailableCount()], [1, 1]);
  eq('3 files + 1 YouTube embed -> 3 downloadable, 1 unavailable (row: Partial 3/4)',
    [(await artstation.extractImageUrls(asDoc(null), `${AS}/artwork/MULTI1`, { fetch: asFetch(asTable) })).length,
      artstation.unavailableCount()], [3, 1]);

  let calls = 0;
  const flaky = { [`${AS}/projects/SINGLE.json`]: () => (++calls === 1 ? 429 : asProject('SINGLE', '2025-01-01', [asImage(9)])) };
  asParsers.waits.length = 0;
  const flakyItems = await artstation.extractImageUrls(asDoc(null), `${AS}/artwork/SINGLE`, { fetch: asFetch(flaky) });
  eq('429 -> waits, retries, succeeds', [flakyItems.length, asParsers.waits.includes(5000)], [1, true]);

  // Portfolio: 3 projects over 2 pages, newest first.
  const portfolio = {
    [`${AS}/users/someartist/projects.json?page=1`]: { total_count: 3, data: [
      { hash_id: 'P1', published_at: '2026-05-01T00:00:00Z' }, { hash_id: 'P2', published_at: '2025-06-01T00:00:00Z' }] },
    [`${AS}/users/someartist/projects.json?page=2`]: { total_count: 3, data: [
      { hash_id: 'P3', published_at: '2024-01-01T00:00:00Z' }] },
    [`${AS}/projects/P1.json`]: asProject('P1', '2026-05-01', [asImage(11), asImage(12)]),
    [`${AS}/projects/P2.json`]: asProject('P2', '2025-06-01', [asImage(21)]),
    [`${AS}/projects/P3.json`]: asProject('P3', '2024-01-01', [asImage(31)]),
  };
  const progress = [];
  let fetchLog = [];
  const all = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist`,
    { fetch: asFetch(portfolio, fetchLog), onProgress: (n, t) => progress.push(`${n}/${t}`) });
  eq('portfolio: every project across pages', all.images.length, 4);
  eq('portfolio: progress reported per project', progress, ['1/3', '2/3', '3/3']);

  fetchLog = [];
  const onePage = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist`,
    { fetch: asFetch(portfolio, fetchLog), paginate: false });
  eq('"Follow gallery pages" off: first page only', [onePage.images.length, fetchLog.some((u) => u.includes('page=2'))], [3, false]);

  fetchLog = [];
  const recent = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist`,
    { fetch: asFetch(portfolio, fetchLog), maxDate: '2025-07-01' });
  eq('max date: older projects not fetched, stops paging', [recent.images.length,
    fetchLog.some((u) => u.includes('P2.json')), fetchLog.some((u) => u.includes('page=2'))], [2, false, false]);

  // Albums: /{name}/albums/{id} lists projects through the same endpoint plus
  // album_id; /albums/all is the whole portfolio.
  eq('album pages are index views', ['/someartist/albums/57154', '/someartist/albums/57154/', '/someartist/albums/all']
    .map((p) => artstation.isIndexView('www.artstation.com', p)), [true, true, true]);
  eq('not albums: other sub-pages, non-numeric ids, site sections', ['/someartist/likes', '/someartist/albums/abc',
    '/someartist/albums', '/artwork/albums/1', '/search/albums/1']
    .map((p) => artstation.isIndexView('www.artstation.com', p)), [false, false, false, false, false]);
  eq('album path parsed', [asParsers.ARTSTATION_INTERNALS.portfolioFromPath('/someartist/albums/57154'),
    asParsers.ARTSTATION_INTERNALS.portfolioFromPath('/someartist/albums/all'),
    asParsers.ARTSTATION_INTERNALS.portfolioFromPath('/someartist')],
    [{ username: 'someartist', albumId: '57154' }, { username: 'someartist', albumId: null },
     { username: 'someartist', albumId: null }]);
  // Album order is the artist's own, so an old project can come before newer ones.
  const album = {
    [`${AS}/users/someartist/projects.json?page=1&album_id=57154`]: { total_count: 3, data: [
      { hash_id: 'P3', published_at: '2024-01-01T00:00:00Z' }, { hash_id: 'P1', published_at: '2026-05-01T00:00:00Z' }] },
    [`${AS}/users/someartist/projects.json?page=2&album_id=57154`]: { total_count: 3, data: [
      { hash_id: 'P2', published_at: '2025-06-01T00:00:00Z' }] },
    [`${AS}/projects/P1.json`]: portfolio[`${AS}/projects/P1.json`],
    [`${AS}/projects/P2.json`]: portfolio[`${AS}/projects/P2.json`],
    [`${AS}/projects/P3.json`]: portfolio[`${AS}/projects/P3.json`],
  };
  fetchLog = [];
  const albumAll = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist/albums/57154`,
    { fetch: asFetch(album, fetchLog) });
  eq('album: only the album\'s projects, across pages', [albumAll.images.length,
    fetchLog.filter((u) => u.includes('projects.json?')).every((u) => u.includes('album_id=57154'))], [4, true]);
  fetchLog = [];
  const albumRecent = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist/albums/57154`,
    { fetch: asFetch(album, fetchLog), maxDate: '2025-01-01' });
  eq('album + max date: old projects skipped, but paging continues (album order is not by date)',
    [albumRecent.images.length, fetchLog.some((u) => u.includes('P3.json')), fetchLog.some((u) => u.includes('page=2'))],
    [3, false, true]);
  fetchLog = [];
  await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist/albums/all`, { fetch: asFetch(portfolio, fetchLog) });
  eq('/albums/all is the plain portfolio request', fetchLog[0], `${AS}/users/someartist/projects.json?page=1`);
  fetchLog = [];
  const badHash = await artstation.extractIndexLinks(asDoc(null), `${AS}/someartist`, { fetch: asFetch({
    [`${AS}/users/someartist/projects.json?page=1`]: { total_count: 1, data: [{ hash_id: '../x', published_at: '2026-01-01' }] },
  }, fetchLog) });
  eq('a malformed project id is never put into a request', [badHash.images.length, fetchLog.length], [0, 1]);

  section('file names: "_by_{author}" for ArtStation and Pinterest');
  const cn = loadContent(true, () => Promise.resolve());
  eq('author appended to the stem, extension kept', [
    cn.itemFilename({ imageUrl: `${CDN}/images/images/000/000/1/4k/someartist-pic1.jpg?1700000000`, author: 'someartist' }),
    cn.itemFilename({ imageUrl: 'https://cdn.artstation.com/p/video_sources/1/clip.mp4', filename: '3_clip.mp4', author: 'someartist' }),
    cn.itemFilename({ imageUrl: 'https://i.pinimg.com/736x/8f/95/cf/8f95cf0377c08421d1fad420150f0ac1.jpg', author: 'nmicreative' }),
  ], ['someartist-pic1_by_someartist.jpg', '3_clip_by_someartist.mp4', '8f95cf0377c08421d1fad420150f0ac1_by_nmicreative.jpg']);
  eq('no author (e.g. DeviantArt, or unknown) -> name unchanged', [
    cn.itemFilename({ imageUrl: 'https://images-wixmp-x.wixmp.com/f/u/x.jpg', filename: 'barn_by_who_dmfgrtd-fullview.jpg' }),
    cn.itemFilename({ imageUrl: 'https://i.pinimg.com/736x/a.jpg', author: '' })],
    ['barn_by_who_dmfgrtd-fullview.jpg', 'a.jpg']);
  eq('author made file-name safe, never doubled', [
    cn.itemFilename({ imageUrl: 'https://i.pinimg.com/736x/a.jpg', author: '../We ird/Name' }),
    cn.itemFilename({ imageUrl: 'https://i.pinimg.com/736x/a.jpg', author: 'Rénée.Ж' }),
    cn.itemFilename({ imageUrl: 'https://i.pinimg.com/736x/a.jpg', filename: 'a_by_someone.jpg', author: 'someone' })],
    ['a_by_We_ird_Name.jpg', 'a_by_Rénée_Ж.jpg', 'a_by_someone.jpg']);

  // Pinterest: the creator comes from Pinterest's own /resource/ API, called in the tab.
  const PI = loadParsers({ fastTimers: true });
  const pinParser = PI.GALLERY_PARSERS['pinterest.com'];
  const PIN = PI.PINTEREST_INTERNALS;
  eq('creator, not the saver: native_creator, then attribution, then origin pinner; never the pinner alone', [
    PIN.creatorOf({ native_creator: { username: 'maker' }, origin_pinner: { username: 'o' }, pinner: { username: 'saver' } }),
    PIN.creatorOf({ closeup_attribution: { username: 'attr' }, pinner: { username: 'saver' } }),
    PIN.creatorOf({ origin_pinner: { username: 'orig' }, pinner: { username: 'saver' } }),
    PIN.creatorOf({ pinner: { username: 'saver' } })], ['maker', 'attr', 'orig', '']);
  const apiCalls = [];
  const apiFetch = (routes) => (url, init) => {
    apiCalls.push({ url, headers: init && init.headers });
    const u = new URL(url);
    const body = routes[u.pathname];
    const data = JSON.parse(u.searchParams.get('data'));
    const reply = typeof body === 'function' ? body(data.options) : body;
    return Promise.resolve(reply === undefined ? { ok: false, status: 404 }
      : { ok: true, status: 200, json: () => Promise.resolve({ resource_response: reply }) });
  };
  const pinDocOg = mkPinDoc({ og: 'https://i.pinimg.com/736x/8f/95/cf/8f95cf0377c08421d1fad420150f0ac1.jpg' });
  const withCreator = await pinParser.extractImageUrls(pinDocOg, 'https://es.pinterest.com/pin/112097478221971522/', { fetch: apiFetch({
    '/resource/PinResource/get/': { data: { id: '112097478221971522', native_creator: { username: 'nmicreative' }, pinner: { username: 'bhawinjagad' } } } }) });
  eq('pin page: items carry the creator', withCreator.map((i) => [i.imageUrl, i.author]),
    [['https://i.pinimg.com/736x/8f/95/cf/8f95cf0377c08421d1fad420150f0ac1.jpg', 'nmicreative']]);
  eq('pin page: one same-origin PinResource request with the app\'s headers', [apiCalls.length, new URL(apiCalls[0].url).origin,
    JSON.parse(new URL(apiCalls[0].url).searchParams.get('data')).options.id, apiCalls[0].headers['X-Pinterest-PWS-Handler']],
    [1, 'https://es.pinterest.com', '112097478221971522', 'www/pin/[id].js']);
  eq('pin page: API unavailable -> same items, no author', (await pinParser.extractImageUrls(pinDocOg,
    'https://www.pinterest.com/pin/1/', { fetch: apiFetch({}) })).map((i) => i.author), [undefined]);

  apiCalls.length = 0;
  const feedPin = (id, hash, creator) => ({ type: 'pin', id, native_creator: creator && { username: creator },
    pinner: { username: 'boardowner' }, images: { '236x': { url: `https://i.pinimg.com/236x/aa/bb/cc/${hash}.jpg` },
      '736x': { url: `https://i.pinimg.com/736x/aa/bb/cc/${hash}.jpg` } } });
  const boardImgs = ['h1', 'h2', 'h3'].map((h) => ({ currentSrc: `https://i.pinimg.com/236x/aa/bb/cc/${h}.jpg`, naturalWidth: 236, naturalHeight: 300, alt: '' }));
  const boardDoc2 = { querySelector: () => null, querySelectorAll: () => [], images: boardImgs };
  const boardOut = await pinParser.extractIndexLinks(boardDoc2, 'https://www.pinterest.com/someuser/wallpapers/', { fetch: apiFetch({
    '/resource/BoardResource/get/': { data: { id: 'B1' } },
    '/resource/BoardFeedResource/get/': (o) => (o.bookmarks
      ? { data: [feedPin('3', 'h3', null), { type: 'story' }], bookmark: '-end-' }
      : { data: [feedPin('1', 'h1', 'maker1'), feedPin('2', 'h2', 'maker2')], bookmark: 'NEXT' }) }) });
  eq('board: each pin gets its own creator (matched by image hash); unknown creator -> no author',
    boardOut.images.map((i) => [i.imageUrl.split('/').pop(), i.author]), [['h1.jpg', 'maker1'], ['h2.jpg', 'maker2'], ['h3.jpg', undefined]]);
  eq('board: board id looked up, feed paged by bookmark', apiCalls.map((c) => new URL(c.url).pathname.split('/')[2]),
    ['BoardResource', 'BoardFeedResource', 'BoardFeedResource']);
  apiCalls.length = 0;
  await pinParser.extractIndexLinks(boardDoc2, 'https://www.pinterest.com/someuser/', { fetch: apiFetch({}) });
  eq('profile page: no board feed requests', apiCalls.length, 0);

  env = loadBackground({ scriptResult: { ok: true, status: 200, body: '{}' } });
  await env.ask({ command: 'page-fetch', url: 'https://www.pinterest.com/resource/PinResource/get/?data=x',
    headers: { Accept: 'application/json', 'X-Pinterest-PWS-Handler': 'www/pin/[id].js', Cookie: 'a=b', Authorization: 'x', 'X-Requested-With': 'a\r\nInjected: 1' } },
    { id: EXT_ID, tab: { id: 8, url: 'https://www.pinterest.com/pin/1/' } });
  eq('page-fetch passes only allow-listed, single-line headers', env.scriptCalls[0].args[1],
    { Accept: 'application/json', 'X-Pinterest-PWS-Handler': 'www/pin/[id].js' });

  section('security: parsers accept only their own media hosts');
  // ArtStation: a player page or clip file on another host is never fetched
  // or returned, and a %2F in a clip name cannot create a folder.
  const evilEmbed = 'https://evil.example/api/v2/animation/video_clips/x/embed.html';
  const evilClipPage = '<source media="(min-width: 0px)" src="https://evil.example/p/video_sources/a.mp4" />';
  const slashClipPage = '<source media="(min-width: 0px)" src="https://cdn.artstation.com/p/video_sources/1/..%2F..%2Fevil.mp4" />';
  const relClipPage = '<source media="(min-width: 0px)" src="/p/video_sources/1/rel.mp4" />';
  const clipAsset = (id, embed) => ({ asset_type: 'video_clip', has_image: true, id, image_url: `${CDN}/v/t.jpg`,
    player_embedded: `<iframe src='${embed}'></iframe>` });
  const clipEmbed2 = `${AS}/api/v2/animation/video_clips/2222-bbbb/embed.html?s=sig&t=1`;
  const clipEmbed3 = `${AS}/api/v2/animation/video_clips/3333-cccc/embed.html?s=sig&t=1`;
  const secLog = [];
  const secItems = await artstation.extractImageUrls(asDoc(null), `${AS}/artwork/SEC1`, { fetch: asFetch({
    [`${AS}/projects/SEC1.json`]: asProject('SEC1', '2025-01-01', [
      clipAsset(41, evilEmbed), clipAsset(42, clipEmbed), clipAsset(43, clipEmbed2), clipAsset(44, clipEmbed3),
      { asset_type: 'image', has_image: true, id: 45, image_url: 'https://evil.example/p/assets/images/images/large/x.jpg' }]),
    [clipEmbed]: evilClipPage, [clipEmbed2]: slashClipPage, [clipEmbed3]: relClipPage,
  }, secLog) });
  eq('ArtStation: player page on another host is never fetched', secLog.includes(evilEmbed), false);
  eq('ArtStation: only ArtStation-hosted files survive, relative clip sources resolve against ArtStation',
    secItems.map((i) => i.imageUrl), [
      'https://cdn.artstation.com/p/video_sources/1/..%2F..%2Fevil.mp4',
      'https://www.artstation.com/p/video_sources/1/rel.mp4']);
  eq('ArtStation: a decoded %2F never reaches the filename as a folder',
    /[\\/]/.test(secItems[0].filename), false);
  eq('ArtStation: rendered <video> on another host is ignored',
    (await artstation.extractImageUrls(asDoc(null, [renderedAsset([], ['https://evil.example/clip.mp4', renderedVideo])]),
      `${AS}/artwork/GONE`, { fetch: asFetch({}) })).map((i) => i.imageUrl), [renderedVideo]);

  // Pinterest: the moderator's exact case, plus lookalikes, in user-written text.
  const realVideo = 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4';
  const evilHtml = '<html><body><div class="description">'
    + 'https://evil.example/x?.pinimg.com/videos/a.mp4 '
    + 'https://pinimg.com.evil.example/videos/b.mp4 '
    + 'https://v1.pinimg.com@evil.example/videos/c.mp4 '
    + 'http://v1.pinimg.com/videos/d.mp4 '
    + '</div></body></html>';
  eq('Pinterest: crafted video URLs in page text are all ignored',
    (await pinterest.extractImageUrls(mkPinDoc({ html: evilHtml }), 'https://www.pinterest.com/pin/456/')), []);
  eq('Pinterest: ...while a real pinimg video next to them is still found',
    (await pinterest.extractImageUrls(mkPinDoc({ html: evilHtml.replace('</div>', ` ${realVideo}</div>`) }),
      'https://www.pinterest.com/pin/456/')).map((i) => i.imageUrl), [realVideo]);
  eq('Pinterest: a <video> on another host is ignored',
    (await pinterest.extractImageUrls(mkPinDoc({ videos: [{ currentSrc: 'https://evil.example/v.mp4', querySelectorAll: () => [] }] }),
      'https://www.pinterest.com/pin/456/')), []);
  eq('Pinterest: og:image on another host is ignored',
    (await pinterest.extractImageUrls(mkPinDoc({ og: 'https://evil.example/a.jpg' }), 'https://www.pinterest.com/pin/456/')), []);

  // DeviantArt: media in the page state must be on DeviantArt's file hosts.
  const daEvil = (b, baseUri) => ({ '@@entities': {
    deviation: { 9: { title: 'T', author: 1, url: 'https://www.deviantart.com/a/art/T-9',
      media: { baseUri, prettyName: 'work', token: [], types: b ? [{ t: 'video', b, h: 720 }] : [{ t: 'fullview', c: '', r: 0 }] } } },
    deviationExtended: { 9: {} }, user: { 1: { username: 'a' } } } });
  const daParser = loadParsers().GALLERY_PARSERS['deviantart.com'];
  eq('DeviantArt: video on another host is dropped', daParser.parseDeviationHtml(
    `window.__INITIAL_STATE__ = JSON.parse("${JSON.stringify(daEvil('https://evil.example/v.mp4', 'https://images-wixmp-x.wixmp.com/f/p.jpg')).replace(/"/g, '\\"')}");`,
    'https://www.deviantart.com/a/art/T-9').images, []);
  eq('DeviantArt: image on another host is dropped', daParser.parseDeviationHtml(
    `window.__INITIAL_STATE__ = JSON.parse("${JSON.stringify(daEvil(null, 'http://images-wixmp-x.wixmp.com/f/p.jpg')).replace(/"/g, '\\"')}");`,
    'https://www.deviantart.com/a/art/T-9').images, []);
  eq('DeviantArt: real wixmp video is kept', daParser.parseDeviationHtml(
    `window.__INITIAL_STATE__ = JSON.parse("${JSON.stringify(daEvil('https://wixmp-ed30a86b8c4ca887773594c2.wixmp.com/v/mp4/u/d.mp4', 'https://images-wixmp-x.wixmp.com/f/p.jpg')).replace(/"/g, '\\"')}");`,
    'https://www.deviantart.com/a/art/T-9').images.map((i) => i.imageUrl), ['https://wixmp-ed30a86b8c4ca887773594c2.wixmp.com/v/mp4/u/d.mp4']);

  section('panel: theme toggle and toolbar controls');
  const panelHtml = fs.readFileSync(path.join(ROOT, 'src/sidebar.html'), 'utf8');
  const themeJs = fs.readFileSync(path.join(ROOT, 'src/theme.js'), 'utf8');
  eq('theme toggle is empty in the markup (theme.js draws the SVG icon)',
    /<button id="themeToggle"[^>]*><\/button>/.test(panelHtml), true);
  eq('theme.js builds the icon with createElementNS, no innerHTML or emoji',
    [themeJs.includes('createElementNS'), /innerHTML|\\u2600|\\ud83c/.test(themeJs)], [true, false]);
  eq('media selector offers all / images / videos; Skip videos checkbox is gone',
    [(panelHtml.match(/<select id="mediaFilterSelect"[\s\S]*?<\/select>/) || [''])[0].match(/value="(\w+)"/g),
     panelHtml.includes('id="skipVideos"'), panelHtml.includes('id="gifAsVideo"')],
    [['value="all"', 'value="images"', 'value="videos"'], false, true]);

  section('manifests: minimal permissions');
  const GALLERY_HOSTS = ['https://*.artstation.com/*', 'https://*.deviantart.com/*', 'https://*.pinterest.com/*'];
  for (const browser of ['firefox', 'chrome', 'opera']) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, `manifests/${browser}.json`), 'utf8'));
    eq(`${browser}: host access only to the three galleries`,
      [m.host_permissions, m.optional_host_permissions || null], [GALLERY_HOSTS, null]);
    eq(`${browser}: no <all_urls>, tabs or activeTab`,
      [...m.permissions, ...m.host_permissions].filter((p) => ['<all_urls>', 'tabs', 'activeTab'].includes(p)), []);
  }
  eq('every registered gallery is covered by a host permission',
    Object.keys(loadParsers().GALLERY_PARSERS).every((d) => GALLERY_HOSTS.includes(`https://*.${d}/*`)), true);

  env = loadBackground();
  await env.s.downloadImagesSequentially(
    [{ id: 1, url: undefined, title: undefined }, { id: 2, url: 'https://example.org/', title: 'Other' }],
    '', {}, 0, 'deviantart.com', '', true, false, false, true, 5, false);
  eq('tabs the browser hides (no url) and other sites are skipped quietly',
    env.broadcasts.filter((m) => m.type === 'download-progress').length, 0);

  section('interface languages');
  const { pathToFileURL } = require('url');
  const loadLocale = async (lang) => (await import(pathToFileURL(path.join(ROOT, `src/locales/${lang}.js`)).href)).default;
  const en = await loadLocale('en');
  const langs = fs.readdirSync(path.join(ROOT, 'src/locales')).map((f) => f.replace('.js', '')).filter((l) => l !== 'en');
  const mismatched = [];
  for (const lang of langs) {
    const keys = Object.keys(await loadLocale(lang)).sort();
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(en).sort())) mismatched.push(lang);
  }
  eq('every language has exactly the English keys', mismatched, []);
  eq('the disk-space / layout notice is translated everywhere',
    (await Promise.all(langs.map(loadLocale))).every((l) => l.noticeLabel && l.noticeText && l.noticeText !== en.noticeText), true);

  const F = loadParsers().findGalleryDomain;
  eq('regional host matches', F('es.pinterest.com'), 'pinterest.com');
  eq('lookalike rejected', F('notx.com.evil.net'), null);

  console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
  process.exit(fails ? 1 : 0);
})();
