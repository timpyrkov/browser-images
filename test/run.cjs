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
// `interrupts` maps a URL to the reasons its next downloads are interrupted
// with, e.g. { 'https://x/a.jpg': ['SERVER_FORBIDDEN'] }; `'*'` applies to all.
// `session` is the storage.session backing object; pass the same one to a
// second loadBackground() to simulate the browser unloading and restarting
// the background. `openTabs` are the tab ids tabs.query({}) reports.
// `sidePanel`: 'ok' mimics Chrome, 'fails' a side panel API that rejects,
// absent mimics Yandex / Opera (no chrome.sidePanel).
function loadBackground({ history = [], failUrls = [], interrupts = {}, session = {}, openTabs = [], sidePanel } = {}) {
  const broadcasts = [], started = [], intervals = [], fetched = [], removed = [], localRemoved = [];
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
    DEFAULT_SETTINGS: { rateLimit: 0.5, batchSize: 5, skipDownloaded: true, skipVideos: false },
    chrome: {
      runtime: { onInstalled: { addListener(){} }, onMessage: { addListener: (f) => { handler = f; } },
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
      storage: { local: { set(){}, get: (k, cb) => cb && cb({}), remove: (keys) => { localRemoved.push(...keys); return Promise.resolve(); } },
        session: {
          get: (key) => Promise.resolve(key in session ? { [key]: JSON.parse(JSON.stringify(session[key])) } : {}),
          set: (obj) => { for (const [k, v] of Object.entries(obj)) session[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
          remove: (key) => { delete session[key]; return Promise.resolve(); },
        } },
      tabs: { query: (q, cb) => (cb ? cb([]) : Promise.resolve(openTabs.map((id) => ({ id })))),
        remove: (ids) => { removed.push(...ids); return Promise.resolve(); },
        sendMessage: () => Promise.resolve() },
      scripting: { executeScript: () => Promise.resolve() } } };
  if (sidePanel) {
    s.chrome.sidePanel = {
      open: () => Promise.resolve(),
      setPanelBehavior: (b) => { panel.behavior.push(b); return sidePanel === 'ok' ? Promise.resolve() : Promise.reject(new Error('no side panel')); },
    };
    s.chrome.action = { setPopup: (p) => { panel.popups.push(p); return Promise.resolve(); } };
    s.chrome.runtime.onStartup = { addListener: (f) => panel.onStartup.push(f) };
  }
  s.self = s; vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), s, { filename: 'background.js' });
  s.fetch = (url) => { fetched.push(url); return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(url) }); };
  // Send a command the way a panel does and wait for the (possibly async) reply.
  const ask = (message) => new Promise((resolve) => {
    const async = handler(message, {}, resolve);
    if (async !== true) setImmediate(() => resolve(undefined));
  });
  return { s, broadcasts, started, intervals, fetched, removed, localRemoved, session, panel, ask, getHandler: () => handler };
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
  const imgs = (n) => Array.from({ length: n }, (_, i) => ({ imageUrl: `https://x/img${i}.jpg`, filename: `img${i}.jpg` }));
  const lastRow = (b) => b.filter((m) => m.type === 'download-progress').map((m) => m.item).pop();

  let env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(6) }, PATHS, env.s.createThrottle(0), true, false);
  eq('6 fresh -> downloaded (6)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['downloaded', 6]);

  env = loadBackground({ history: ['/d/PIC/img0.jpg', '/d/PIC/img1.jpg', '/d/PIC/img2.jpg'] });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(3) }, PATHS, env.s.createThrottle(0), true, false);
  eq('all duplicates -> skipped (3)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['skipped', 3]);

  env = loadBackground({ failUrls: ['https://x/img0.jpg'] });
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(1) }, PATHS, env.s.createThrottle(0), true, false);
  eq('failure -> error (1)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count], ['error', 1]);

  section('background: paced downloads (Pinterest policy)');
  const POLICY = { awaitCompletion: true, minDelaySeconds: 1.5 };
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: imgs(3) }, PATHS, env.s.createThrottle(0), true, false, POLICY);
  eq('paced: all complete -> downloaded (3)', [lastRow(env.broadcasts).status, lastRow(env.broadcasts).count, env.started.length], ['downloaded', 3, 3]);

  env = loadBackground({ interrupts: { 'https://x/img0.jpg': ['SERVER_FORBIDDEN'] } });
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

  section('background: skip videos');
  const mixed = [{ imageUrl: 'https://x/a.jpg', filename: 'a.jpg' },
                 { imageUrl: 'https://x/v.mp4', filename: 'clip.mp4' }];
  env = loadBackground();
  eq('off: nothing dropped', env.s.withoutVideos(mixed, false).dropped, 0);
  eq('on: the mp4 is dropped', env.s.withoutVideos(mixed, true).keep.map((i) => i.filename), ['a.jpg']);
  env = loadBackground();
  await env.s.downloadTabImages(TAB, { title: 'x', images: mixed }, PATHS, env.s.createThrottle(0), false, true);
  eq('only the image downloads', env.started.length, 1);

  section('background: messages, throttle, ETA, keepalive');
  env = loadBackground();
  let replied = null;
  eq('scan-all-tabs returns false', env.getHandler()({ command: 'scan-all-tabs' }, {}, (r) => { replied = r; }), false);
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

  section('background: date cutoff early stop');
  const day = (n) => `2026-08-${String(n).padStart(2, '0')}`;
  const dates = Array.from({ length: 30 }, (_, i) => day(30 - i));
  const parser = { parseDeviationHtml: (html) => {
    const i = Number(html.split('#')[1]);
    return { images: [{ imageUrl: `https://x/${i}.jpg`, filename: `img${i}.jpg` }], title: `D${i}`, pageDate: dates[i] };
  } };
  const links = dates.map((_, i) => `https://www.deviantart.com/a/art/W-${i}#${i}`);
  const runIndex = (e, ctx) => e.s.downloadIndexTab({ id: 1, url: 'u', title: 'G' }, links, {
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
    pinterest.extractImageUrls(videoPinDoc, 'https://www.pinterest.com/pin/456/').map((i) => ({ url: i.imageUrl, kind: i.kind })),
    [{ url: 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4', kind: 'video' }]);

  // 1b. Same video offered in multiple codecs/sizes collapses to one best URL.
  const codecVariantsHtml = '<html><body>'
    + 'https://v1.pinimg.com/videos/iht/hevcMp4V3/5b/5d/0f/hash123_360w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/hevcMp4V4/5b/5d/0f/hash123_240w.mp4 '
    + 'https://v1.pinimg.com/videos/iht/expMp4/5b/5d/0f/hash123_720w.mp4'
    + '</body></html>';
  const codecPinDoc = mkPinDoc({ html: codecVariantsHtml, og: 'https://i.pinimg.com/736x/00/00/00/poster.jpg' });
  eq('single video with multiple codec/size variants returns one best URL',
    pinterest.extractImageUrls(codecPinDoc, 'https://www.pinterest.com/pin/111/').map((i) => i.imageUrl),
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
    pinterest.extractImageUrls(multiVideoPinDoc, 'https://www.pinterest.com/pin/789/').map((i) => i.imageUrl).sort(),
    ['https://v1.pinimg.com/videos/iht/expMp4/a1/b2/c3/abc123_720w.mp4', 'https://v1.pinimg.com/videos/iht/expMp4/e4/63/79/e46379418e1015e4a45111cf05361c00_720w.mp4']);

  // 2. og:image is used for static pins.
  const ogPin = mkPinDoc({ og: 'https://i.pinimg.com/736x/00/00/00/og.jpg', closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/dom.jpg', src: 'https://i.pinimg.com/736x/00/00/00/dom.jpg' } });
  eq('og:image wins over closeup selector for static pin',
    pinterest.extractImageUrls(ogPin, 'https://www.pinterest.com/pin/123/').map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/og.jpg']);

  // 3. Live DOM closeup hook is a fallback when og:image is missing.
  const hookPin = mkPinDoc({ closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/dom.jpg', src: 'https://i.pinimg.com/736x/00/00/00/dom.jpg' } });
  eq('closeup hook fallback works',
    pinterest.extractImageUrls(hookPin, 'https://www.pinterest.com/pin/123/').map((i) => i.imageUrl),
    ['https://i.pinimg.com/736x/00/00/00/dom.jpg']);

  // 4. Non-pinimg URLs are rejected and fall back to the next source.
  const badOgPin = mkPinDoc({ og: 'https://evil.com/img.jpg', closeup: { currentSrc: 'https://i.pinimg.com/736x/00/00/00/good.jpg', src: 'https://i.pinimg.com/736x/00/00/00/good.jpg' } });
  eq('non-pinimg og:image is ignored',
    pinterest.extractImageUrls(badOgPin, 'https://www.pinterest.com/pin/123/').map((i) => i.imageUrl),
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
    pinterest.extractImageUrls(largestPinDoc, 'https://www.pinterest.com/pin/123/').map((i) => i.imageUrl),
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
  const boardResult = pinterest.extractIndexLinks(boardDoc, 'https://www.pinterest.com/someuser/wallpapers/', {});
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
    (pinterest.extractIndexLinks(wrapperDoc, 'https://www.pinterest.com/someuser/wallpapers/', {}).images || []).length, 2);

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
  const asDoc = (og) => ({ querySelector: (sel) => (sel.includes('og:image') && og ? { getAttribute: () => og } : null) });

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
  eq('clip gets a unique filename (artist_asset_name)', multiItems[1].filename, 'someartist_3_clip.mp4');
  eq('artwork carries its published date', multiItems[0].pageDate, '2024-10-08');

  eq('JSON blocked -> og:image fallback',
    (await artstation.extractImageUrls(asDoc(`${CDN}/og.jpg`), `${AS}/artwork/GONE`, { fetch: asFetch({}) }))
      .map((i) => i.imageUrl), [`${CDN}/og.jpg`]);

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

  const F = loadParsers().findGalleryDomain;
  eq('regional host matches', F('es.pinterest.com'), 'pinterest.com');
  eq('lookalike rejected', F('notx.com.evil.net'), null);

  console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
  process.exit(fails ? 1 : 0);
})();
