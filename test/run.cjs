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
function loadBackground({ history = [], failUrls = [] } = {}) {
  const broadcasts = [], started = [], intervals = [], fetched = [];
  let handler = null;
  const s = { console: { log(){}, warn(){}, error(){} },
    setTimeout: (fn) => fn(), clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => intervals.splice(id - 1, 1),
    Math, Date, URL, Promise, Number, Set, Error, AbortController,
    DEFAULT_SETTINGS: { rateLimit: 0.5, batchSize: 5, skipDownloaded: true, skipVideos: false },
    chrome: {
      runtime: { onInstalled: { addListener(){} }, onMessage: { addListener: (f) => { handler = f; } },
        sendMessage: (m) => { broadcasts.push(m); return Promise.resolve(); },
        getPlatformInfo: (cb) => cb && cb({}), lastError: null },
      downloads: { onChanged: { addListener(){}, removeListener(){} },
        search: ({ query }) => Promise.resolve(history.filter((h) => h.includes(query[0])).map((h) => ({ filename: h }))),
        download: ({ url, filename }) => failUrls.includes(url)
          ? Promise.reject(new Error('network failure'))
          : (started.push(filename), Promise.resolve(started.length)) },
      storage: { local: { set(){}, get: (k, cb) => cb && cb({}) } },
      tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve() },
      scripting: { executeScript: () => Promise.resolve() } } };
  s.self = s; vm.createContext(s);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8'), s, { filename: 'background.js' });
  s.fetch = (url) => { fetched.push(url); return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(url) }); };
  return { s, broadcasts, started, intervals, fetched, getHandler: () => handler };
}

/* --------------------------------------------------------------- parsers */
function loadParsers() {
  const s = { console: { log(){}, warn(){}, error(){} }, URL, Math, Set, RegExp, Number,
    parseInt, parseFloat, encodeURIComponent, setTimeout, Promise, Array,
    document: { hidden: false }, location: { href: 'https://x/', hostname: 'x' } };
  s.self = s; s.window = s; vm.createContext(s);
  for (const f of ['src/naming.js', 'src/galleries.js', 'src/galleries/deviantart.js', 'src/galleries/pinterest.js']) {
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
  const P = loadParsers().GALLERY_PARSERS['deviantart.com'];
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
  const F = loadParsers().findGalleryDomain;
  eq('regional host matches', F('es.pinterest.com'), 'pinterest.com');
  eq('lookalike rejected', F('notx.com.evil.net'), null);

  console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
  process.exit(fails ? 1 : 0);
})();
