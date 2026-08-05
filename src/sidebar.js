// UI logic for the Browser Images sidebar.
import { t, detectBrowserLanguage, UI_FLAGS } from './i18n.js';
import { LANGUAGES } from './languages.js';

const brw = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {
  folder: '',
  galleryPaths: {},
  theme: 'dark',
  gallery: 'artstation.com',
  uiLang: 'en',
  maxDate: '',
  rateLimit: 0.5,
  skipDownloaded: true,
  preferPreview: false,
  expandGalleries: false,
  galleryPaginate: true,
  batchSize: 10,
};

// galleries.js keeps this sorted by label; the fallback below is only used if
// that script failed to load, so it is sorted here too.
const SUPPORTED_GALLERIES = ((typeof window !== 'undefined' && window.SUPPORTED_GALLERIES) || [
  { key: 'artstation.com', label: 'ArtStation' },
  { key: 'behance.net', label: 'Behance' },
  { key: 'bsky.app', label: 'Bluesky' },
  { key: 'deviantart.com', label: 'DeviantArt' },
  { key: 'dribbble.com', label: 'Dribbble' },
  { key: 'flickr.com', label: 'Flickr' },
  { key: 'imgur.com', label: 'Imgur' },
  { key: 'instagram.com', label: 'Instagram' },
  { key: 'pinterest.com', label: 'Pinterest' },
  { key: 'pixiv.net', label: 'Pixiv' },
  { key: 'reddit.com', label: 'Reddit' },
  { key: 'tumblr.com', label: 'Tumblr' },
  { key: 'x.com', label: 'X (Twitter)' },
  { key: 'unsplash.com', label: 'Unsplash' },
  { key: '500px.com', label: '500px' },
  { key: 'wallhaven.cc', label: 'Wallhaven' },
  { key: 'zerochan.net', label: 'Zerochan' },
]).slice().sort((a, b) => a.label.localeCompare(b.label));

const state = {
  settings: null,
  log: [],
  filter: 'all',
  scanning: false,
  pickerView: new Date(),
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function setText(el, value) {
  if (el) el.textContent = value;
}

function setHtml(el, value) {
  if (el) el.innerHTML = value;
}

async function loadSettings() {
  const defaults = {
    ...DEFAULT_SETTINGS,
    uiLang: detectBrowserLanguage(),
    maxDate: '',
  };
  const stored = await brw.storage.local.get(Object.keys(defaults));
  state.settings = { ...defaults, ...stored };
  // Ensure every supported gallery has an { images, videos } path entry.
  if (!state.settings.galleryPaths) {
    state.settings.galleryPaths = {};
  }
  SUPPORTED_GALLERIES.forEach((g) => {
    const entry = state.settings.galleryPaths[g.key];
    if (!entry || typeof entry === 'string') {
      state.settings.galleryPaths[g.key] = {
        images: typeof entry === 'string' ? entry : 'PIC',
        videos: 'MOV',
      };
    } else if (!entry.images || !entry.videos) {
      state.settings.galleryPaths[g.key] = {
        images: entry.images || 'PIC',
        videos: entry.videos || 'MOV',
      };
    }
  });
}

async function saveSettings(updates) {
  state.settings = { ...state.settings, ...updates };
  await brw.storage.local.set(updates);
}

function applyTranslations() {
  const lang = state.settings.uiLang;
  document.title = t(lang, 'appTitle');

  $('maxDate').title = t(lang, 'maxDateLabel');
  setText($('downloadBtn'), t(lang, 'downloadBtn'));
  $('uiLangSelect').title = t(lang, 'uiLangLabel');
  $('gallerySelect').title = t(lang, 'galleryLabel');
  $('gallerySettingsBtn').title = t(lang, 'gallerySettingsLabel');
  $('themeToggle').title = t(lang, 'themeToggleLabel');
  setText($('calClear'), t(lang, 'calendarClear'));
  renderWeekdayHeader();

  // Owns #galleryPathsLabel and the per-kind rows, so their labels and
  // placeholders follow the language too.
  populateGalleryPaths();
  setText($('rateLimitLabel'), t(lang, 'rateLimitLabel'));
  setText($('skipDownloadedLabel'), t(lang, 'skipDownloadedLabel'));
  $('skipDownloadedLabel').title = t(lang, 'skipDownloadedTitle');
  setText($('preferPreviewLabel'), t(lang, 'preferPreviewLabel'));
  $('preferPreviewLabel').title = t(lang, 'preferPreviewTitle');
  setText($('expandGalleriesLabel'), t(lang, 'expandGalleriesLabel'));
  $('expandGalleriesLabel').title = t(lang, 'expandGalleriesTitle');
  setText($('galleryPaginateLabel'), t(lang, 'galleryPaginateLabel'));
  $('galleryPaginateLabel').title = t(lang, 'galleryPaginateTitle');
  setText($('batchSizeLabel'), t(lang, 'batchSizeLabel'));
  setText($('closeDownloadedTabsBtn'), t(lang, 'closeDownloadedTabsBtn'));
  setText($('resetLogBtn'), t(lang, 'resetLogBtn'));
  setText($('stopBtn'), t(lang, 'stopBtn'));

  setText($('summaryTotalLabel'), t(lang, 'summaryTotal'));
  setText($('summaryDownloadedLabel'), t(lang, 'summaryDownloaded'));
  setText($('summarySkippedLabel'), t(lang, 'summarySkipped'));
  setText($('summaryFailedLabel'), t(lang, 'summaryFailed'));

  setText($('filterAll'), t(lang, 'filterAll'));
  setText($('filterDownloaded'), t(lang, 'filterDownloaded'));
  setText($('filterSkipped'), t(lang, 'filterSkipped'));
  setText($('filterFailed'), t(lang, 'filterFailed'));

  if (!state.scanning) {
    setHtml($('welcomeText'), state.log.length === 0 ? t(lang, 'logEmptyHint') : '');
  }
}

function initUiLangSelect() {
  const select = $('uiLangSelect');
  select.innerHTML = '';
  LANGUAGES.forEach((lang) => {
    const option = document.createElement('option');
    option.value = lang.code;
    const flag = UI_FLAGS[lang.code] || '';
    option.textContent = `${flag} ${lang.code.toUpperCase()}`;
    option.selected = lang.code === state.settings.uiLang;
    select.appendChild(option);
  });
  select.addEventListener('change', async () => {
    await saveSettings({ uiLang: select.value });
    applyTranslations();
  });
}

function initGallerySelect() {
  const select = $('gallerySelect');
  select.innerHTML = '';
  SUPPORTED_GALLERIES.forEach((g) => {
    const option = document.createElement('option');
    option.value = g.key;
    option.textContent = g.label;
    select.appendChild(option);
  });

  const savedKey = state.settings.gallery;
  const validKey = SUPPORTED_GALLERIES.some((g) => g.key === savedKey) ? savedKey : SUPPORTED_GALLERIES[0]?.key;
  select.value = validKey;

  if (validKey !== savedKey) {
    state.settings.gallery = validKey;
    saveSettings({ gallery: validKey });
  }

  select.addEventListener('change', async () => {
    await saveSettings({ gallery: select.value });
    applyTranslations();
  });
}

function createPathInput(label, key, kind) {
  const selected = SUPPORTED_GALLERIES.find((g) => g.key === state.settings.gallery) || SUPPORTED_GALLERIES[0];
  const row = document.createElement('div');
  row.className = 'form-group site-row';

  const text = document.createElement('label');
  text.className = 'site-label';
  text.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'site-path';
  input.value = state.settings.galleryPaths[key]?.[kind] || '';
  input.placeholder = t(state.settings.uiLang, 'galleryPathPlaceholder') || 'Subfolder';
  input.title = t(state.settings.uiLang, 'galleryPathTitle') || 'Subfolder under Downloads';
  input.addEventListener('change', async () => {
    const entry = state.settings.galleryPaths[key] || { images: 'PIC', videos: 'MOV' };
    const galleryPaths = {
      ...state.settings.galleryPaths,
      [key]: { ...entry, [kind]: input.value.trim() },
    };
    state.settings.galleryPaths = galleryPaths;
    await saveSettings({ galleryPaths });
  });

  row.appendChild(text);
  row.appendChild(input);
  return row;
}

function populateGalleryPaths() {
  const container = $('sitesList');
  container.innerHTML = '';

  const selectedKey = state.settings.gallery;
  const selected = SUPPORTED_GALLERIES.find((g) => g.key === selectedKey) || SUPPORTED_GALLERIES[0];
  if (!selected) return;

  $('galleryPathsLabel').textContent = t(state.settings.uiLang, 'galleryPathsFor', selected.label);

  container.appendChild(createPathInput(
    t(state.settings.uiLang, 'galleryImagesPathLabel') || 'Images',
    selected.key,
    'images'
  ));
  container.appendChild(createPathInput(
    t(state.settings.uiLang, 'galleryVideosPathLabel') || 'Videos',
    selected.key,
    'videos'
  ));
}

function bindSettingsPanel() {
  const panel = $('gallerySettingsPanel');
  $('gallerySettingsBtn').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  // valueAsNumber, not parseFloat(value): in a comma-decimal locale a typed
  // "2,5" leaves the input invalid, value reads back as "" and parseFloat
  // yields NaN — which used to save 0 and silently disable the delay entirely.
  // An unreadable entry now keeps the stored value instead.
  $('rateLimit').addEventListener('change', async () => {
    const input = $('rateLimit');
    const value = input.valueAsNumber;
    const next = Number.isFinite(value) && value >= 0 ? value : state.settings.rateLimit;
    input.value = next;
    await saveSettings({ rateLimit: next });
  });

  $('skipDownloaded').addEventListener('change', async () => {
    await saveSettings({ skipDownloaded: $('skipDownloaded').checked });
  });

  $('preferPreview').addEventListener('change', async () => {
    await saveSettings({ preferPreview: $('preferPreview').checked });
  });

  $('expandGalleries').addEventListener('change', async () => {
    await saveSettings({ expandGalleries: $('expandGalleries').checked });
  });

  $('galleryPaginate').addEventListener('change', async () => {
    await saveSettings({ galleryPaginate: $('galleryPaginate').checked });
  });

  $('batchSize').addEventListener('change', async () => {
    const input = $('batchSize');
    const value = input.valueAsNumber;
    const next = Number.isFinite(value) && value >= 1 ? Math.min(100, Math.round(value)) : state.settings.batchSize;
    input.value = next;
    await saveSettings({ batchSize: next });
  });
}

/**
 * Clock time for an estimate. Same-day finishes show just the time; anything
 * later carries the date, since a large gallery can easily run overnight.
 */
function formatClock(ms, lang) {
  const when = new Date(ms);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * "Started 14:32 · ETA 16:05" for a gallery run, or the elapsed time once it
 * has finished. Returns '' for ordinary single-tab rows, which carry no timing.
 */
function formatTiming(entry) {
  if (!entry.startedAt) return '';
  const lang = state.settings.uiLang;
  const parts = [`${t(lang, 'startedLabel')} ${formatClock(entry.startedAt, lang)}`];
  if (entry.durationMs) {
    parts.push(`${t(lang, 'tookLabel')} ${formatDuration(entry.durationMs)}`);
  } else if (entry.etaAt) {
    parts.push(`${t(lang, 'etaLabel')} ${formatClock(entry.etaAt, lang)}`);
  } else {
    parts.push(`${t(lang, 'etaLabel')} …`);
  }
  return parts.join(' · ');
}

/**
 * Status label for one log row. A tab can hold several images, so the count
 * is appended in brackets: "Downloading (2/6)" while the tab is being worked
 * through, then "Downloaded (6)" for the images that actually landed.
 */
function formatStatus(entry) {
  const key = `status${entry.status.charAt(0).toUpperCase()}${entry.status.slice(1)}`;
  const label = t(state.settings.uiLang, key) || entry.status;
  if ((entry.status === 'downloading' || entry.status === 'scanning') && entry.total > 1) {
    return `${label} (${entry.count}/${entry.total})`;
  }
  if (entry.count > 0) {
    return `${label} (${entry.count})`;
  }
  return label;
}

function renderLog() {
  const list = $('logList');
  list.innerHTML = '';

  let filtered = state.log;
  if (state.filter !== 'all') {
    filtered = state.log.filter((entry) => entry.status === state.filter);
  }

  if (filtered.length === 0) {
    if (!state.scanning) {
      $('welcomeText').style.display = '';
    }
    return;
  }
  $('welcomeText').style.display = 'none';

  filtered.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-row';

    const thumb = document.createElement('img');
    thumb.className = 'log-thumb';
    thumb.src = entry.thumbUrl || 'icons/icon-48.png';
    thumb.alt = '';

    const info = document.createElement('div');
    info.className = 'log-info';

    const title = document.createElement('div');
    title.className = 'log-title';
    title.textContent = entry.title || entry.url || '—';

    const filename = document.createElement('div');
    filename.className = 'log-filename';
    filename.textContent = entry.filename || '';

    info.appendChild(title);
    info.appendChild(filename);

    const timing = formatTiming(entry);
    if (timing) {
      const line = document.createElement('div');
      line.className = 'log-timing';
      line.textContent = timing;
      info.appendChild(line);
    }

    const status = document.createElement('div');
    status.className = `log-status status-${entry.status}`;
    status.textContent = formatStatus(entry);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(status);
    list.appendChild(row);
  });
}

function updateCounts() {
  const counts = { downloaded: 0, skipped: 0, error: 0 };
  state.log.forEach((e) => {
    if (counts[e.status] !== undefined) counts[e.status]++;
  });
  $('countTotal').textContent = state.log.length;
  $('countDownloaded').textContent = counts.downloaded;
  $('countSkipped').textContent = counts.skipped;
  $('countFailed').textContent = counts.error;
  updateCloseTabsButton();
}

function setScanning(scanning) {
  state.scanning = scanning;
  const statusText = $('statusText');
  // Stop is only meaningful mid-run; Download only outside one.
  $('downloadBtn').disabled = scanning;
  $('stopBtn').disabled = !scanning;
  if (scanning) {
    statusText.style.display = '';
    statusText.textContent = t(state.settings.uiLang, 'statusScanning');
    $('welcomeText').style.display = 'none';
    startWatchdog();
  } else {
    stopWatchdog();
    statusText.style.display = 'none';
    if (state.log.length === 0) {
      $('welcomeText').style.display = '';
    }
  }
}

function bindStop() {
  $('stopBtn').addEventListener('click', async () => {
    $('stopBtn').disabled = true;   // one press is enough; the run winds down
    try {
      await brw.runtime.sendMessage({ command: 'stop-scan' });
    } catch (error) {
      console.error('Failed to stop scan:', error);
    }
  });
}

function bindDownload() {
  $('downloadBtn').addEventListener('click', async () => {
    state.log = [];
    updateCounts();
    renderLog();
    setScanning(true);
    try {
      await brw.runtime.sendMessage({ command: 'scan-all-tabs' });
    } catch (error) {
      console.error('Failed to start scan:', error);
    }
  });

  brw.runtime.onMessage.addListener((message) => {
    // Any traffic from the background counts as proof of life.
    if (message?.type) noteBackgroundAlive();
    if (message?.type === 'download-heartbeat') return;
    if (message?.type === 'download-complete') {
      setScanning(false);
      updateCounts();
      renderLog();
      return;
    }
    if (message?.type === 'download-progress' && message.item) {
      if (message.item.status === 'scanning' && message.item.count) {
        const seen = message.item.total
          ? `${message.item.count}/${message.item.total}`
          : `${message.item.count}`;
        $('statusText').textContent = `${t(state.settings.uiLang, 'statusScanning')} (${seen})`;
      }
      const existing = state.log.find((entry) => entry.id === message.item.id);
      if (existing) {
        Object.assign(existing, message.item);
      } else {
        state.log.push(message.item);
      }
      updateCounts();
      renderLog();
    }
  });
}

/*
 * The background can be unloaded mid-run by the browser. It heartbeats every
 * 20s while working, so silence for much longer than that means the run is
 * gone and the sidebar would otherwise show progress forever.
 */
const BACKGROUND_SILENCE_MS = 90000;
let lastBackgroundSignal = 0;
let watchdogTimer = null;

function noteBackgroundAlive() {
  lastBackgroundSignal = Date.now();
}

function startWatchdog() {
  stopWatchdog();
  noteBackgroundAlive();
  watchdogTimer = setInterval(() => {
    if (!state.scanning) return;
    if (Date.now() - lastBackgroundSignal < BACKGROUND_SILENCE_MS) return;
    const seconds = Math.round((Date.now() - lastBackgroundSignal) / 1000);
    console.warn(`[Sidebar] No signal from the background for ${seconds}s.`);
    $('statusText').textContent = t(state.settings.uiLang, 'statusStalled');
  }, 15000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function bindFilters() {
  $('filterChips').addEventListener('click', (e) => {
    if (!e.target.classList.contains('chip')) return;
    state.filter = e.target.dataset.filter;
    document.querySelectorAll('.chip').forEach((btn) => btn.classList.remove('active'));
    e.target.classList.add('active');
    renderLog();
  });
}

function updateCloseTabsButton() {
  const hasDownloaded = state.log.some((entry) => entry.status === 'downloaded' && !entry.closed);
  // Reset shares the bar and stays usable, so only enablement changes here.
  const btn = $('closeDownloadedTabsBtn');
  if (btn) btn.disabled = !hasDownloaded;
}

function resetLog() {
  state.log = [];
  updateCounts();
  renderLog();
  $('welcomeText').style.display = '';
  $('statusText').style.display = 'none';
}

function bindResetLog() {
  $('resetLogBtn').addEventListener('click', resetLog);
}

async function closeDownloadedTabs() {
  const ids = state.log
    .filter((entry) => entry.status === 'downloaded' && !entry.closed && typeof entry.id === 'number' && entry.id > 0)
    .map((entry) => entry.id);

  if (!ids.length) {
    updateCloseTabsButton();
    return;
  }

  try {
    await brw.tabs.remove(ids);
    state.log.forEach((entry) => {
      if (ids.includes(entry.id)) entry.closed = true;
    });
    $('statusText').textContent = t(state.settings.uiLang, 'closeDownloadedTabsDone') || 'Downloaded tabs closed.';
    $('statusText').style.display = '';
    updateCloseTabsButton();
  } catch (error) {
    console.error('Failed to close downloaded tabs:', error);
    $('statusText').textContent = t(state.settings.uiLang, 'closeDownloadedTabsError') || 'Could not close some tabs.';
    $('statusText').style.display = '';
  }
}

function bindCloseDownloadedTabs() {
  $('closeDownloadedTabsBtn').addEventListener('click', closeDownloadedTabs);
}

function formatDateDisplay(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function getYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function updateDatePickerInput() {
  const input = $('maxDate');
  if (!input) return;
  input.value = formatDateDisplay(state.settings.maxDate || '');
}

/**
 * Weekday initials for the calendar header, Monday-first, taken from the
 * selected interface language rather than a hard-coded English list.
 */
function renderWeekdayHeader() {
  const container = $('calWeekdays');
  if (!container) return;
  container.innerHTML = '';
  // 2024-01-01 was a Monday, so this walks Mon..Sun.
  for (let i = 0; i < 7; i++) {
    const cell = document.createElement('span');
    cell.textContent = new Date(2024, 0, 1 + i)
      .toLocaleDateString(state.settings.uiLang, { weekday: 'short' });
    container.appendChild(cell);
  }
}

function renderCalendar() {
  const view = state.pickerView;
  const year = view.getFullYear();
  const month = view.getMonth();
  const monthName = new Date(year, month, 1).toLocaleString(state.settings.uiLang, { month: 'long' });
  $('calMonthYear').textContent = `${monthName} ${year}`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const startOffset = (firstDay + 6) % 7;
  const selected = state.settings.maxDate;
  const container = $('calDays');
  container.innerHTML = '';

  for (let i = 0; i < startOffset; i++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day other-month';
    cell.textContent = prevDays - startOffset + i + 1;
    container.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    cell.textContent = d;
    const dayIndex = (startOffset + d - 1) % 7;
    if (dayIndex === 5 || dayIndex === 6) {
      cell.classList.add('weekend');
    }
    const ymd = getYmd(new Date(year, month, d));
    if (selected === ymd) {
      cell.classList.add('selected');
    }
    cell.addEventListener('click', () => {
      state.settings.maxDate = ymd;
      saveSettings({ maxDate: ymd });
      updateDatePickerInput();
      $('maxDateCalendar').hidden = true;
    });
    container.appendChild(cell);
  }

  const totalCells = startOffset + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day other-month';
    cell.textContent = i;
    container.appendChild(cell);
  }
}

function initDatePicker() {
  updateDatePickerInput();
  if (state.settings.maxDate) {
    state.pickerView = new Date(state.settings.maxDate + 'T00:00:00');
  }

  $('maxDate').addEventListener('click', () => {
    const cal = $('maxDateCalendar');
    cal.hidden = !cal.hidden;
    if (!cal.hidden) renderCalendar();
  });

  $('calPrev').addEventListener('click', () => {
    state.pickerView = new Date(state.pickerView.getFullYear(), state.pickerView.getMonth() - 1, 1);
    renderCalendar();
  });

  $('calNext').addEventListener('click', () => {
    state.pickerView = new Date(state.pickerView.getFullYear(), state.pickerView.getMonth() + 1, 1);
    renderCalendar();
  });

  $('calClear').addEventListener('click', () => {
    state.settings.maxDate = '';
    saveSettings({ maxDate: '' });
    updateDatePickerInput();
    $('maxDateCalendar').hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!$('maxDatePicker').contains(e.target)) {
      $('maxDateCalendar').hidden = true;
    }
  });
}

function applyLoadedSettings() {
  $('rateLimit').value = state.settings.rateLimit;
  $('skipDownloaded').checked = state.settings.skipDownloaded !== false;
  $('preferPreview').checked = state.settings.preferPreview === true;
  $('expandGalleries').checked = state.settings.expandGalleries === true;
  $('galleryPaginate').checked = state.settings.galleryPaginate !== false;
  $('batchSize').value = state.settings.batchSize ?? 30;
  updateDatePickerInput();
  initUiLangSelect();
  initGallerySelect();
  applyTranslations();
}

document.addEventListener('DOMContentLoaded', async () => {
  els.uiLangSelect = $('uiLangSelect');
  els.gallerySelect = $('gallerySelect');
  els.maxDate = $('maxDate');
  els.downloadBtn = $('downloadBtn');
  els.gallerySettingsBtn = $('gallerySettingsBtn');
  els.gallerySettingsPanel = $('gallerySettingsPanel');
  els.rateLimit = $('rateLimit');
  els.sitesList = $('sitesList');
  els.logList = $('logList');
  els.welcomeText = $('welcomeText');
  els.statusText = $('statusText');
  els.actionsBar = $('actionsBar');
  els.closeDownloadedTabsBtn = $('closeDownloadedTabsBtn');
  els.resetLogBtn = $('resetLogBtn');

  await loadSettings();
  bindSettingsPanel();
  bindDownload();
  bindFilters();
  bindStop();
  bindCloseDownloadedTabs();
  bindResetLog();
  initDatePicker();
  applyLoadedSettings();
});
