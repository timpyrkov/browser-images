// Chrome build only: an "open in side panel" button in the toolbar popup.
//
// The popup is the same page as the sidebar (generated from sidebar.html at
// build time). In Chrome the background removes the popup at startup so the
// icon opens the side panel; the popup only shows if clicked before that ran,
// and then this button moves it to the side panel. In browsers without a side
// panel for extensions (e.g. Yandex Browser installing from the Chrome Web
// Store) the button is never added and the popup is the whole UI.
// Opera's build has no button: opening Opera's sidebar from a popup gives a
// panel that does not stay open; Opera users open it from its sidebar icon.
import { t, detectBrowserLanguage } from './i18n.js';

const brw = typeof browser !== 'undefined' ? browser : chrome;
const sidePanel = brw.sidePanel;

if (sidePanel && typeof sidePanel.open === 'function') {
  const button = document.createElement('button');
  button.id = 'openSidebarBtn';
  button.className = 'btn btn-grey icon-btn toolbar-group-gap';
  button.textContent = '\u2197';
  document.getElementById('themeToggle').before(button);

  const setTitle = (lang) => { button.title = t(lang || detectBrowserLanguage(), 'openSidebarLabel'); };
  brw.storage.local.get(['uiLang']).then((settings) => setTitle(settings.uiLang));
  brw.storage.onChanged.addListener((changes) => {
    if (changes.uiLang) setTitle(changes.uiLang.newValue);
  });

  // sidePanel.open() only works inside the click's user gesture, so the
  // window id is looked up in advance rather than awaited in the handler.
  let windowId = null;
  brw.windows.getCurrent().then((win) => { windowId = win.id; });
  button.addEventListener('click', () => {
    if (windowId == null) return;
    sidePanel.open({ windowId })
      .then(() => window.close())
      .catch((error) => console.error('Could not open the side panel:', error));
  });
}
