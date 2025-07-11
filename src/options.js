// options.js
// Handles logic for the settings page (options.html)
// Saves and loads user preferences using browser storage
// Beginner-friendly documentation included

// Get DOM elements
const form = document.getElementById('settings-form');
const folderInput = document.getElementById('folder');
const closeTabsInput = document.getElementById('closeTabs');
const sitesListDiv = document.getElementById('sites-list');
const saveButton = form.querySelector('button');
const themeInputs = document.querySelectorAll('input[name="theme"]');

// For development: use chrome.storage.local instead of chrome.storage.sync
// TODO: Switch back to chrome.storage.sync for production/cross-device sync

if (!chrome || !chrome.storage || !chrome.storage.local) {
  console.error('chrome.storage.local is not available!');
}

// Add a status message span next to the save button if it doesn't exist
let statusSpan = document.getElementById('save-status');
if (!statusSpan) {
  statusSpan = document.createElement('span');
  statusSpan.id = 'save-status';
  statusSpan.style.marginLeft = '1em';
  statusSpan.style.fontWeight = 'normal';
  saveButton.parentElement.appendChild(statusSpan);
}

/**
 * Saves options to chrome.storage.local.
 * @param {Event} e - The form submission event.
 */
function saveOptions(e) {
  e.preventDefault(); // Prevent form from submitting normally

  const allowedSites = {};
  if (document.querySelectorAll) {
    document.querySelectorAll('#sites-list input[type="checkbox"]').forEach(checkbox => {
      allowedSites[checkbox.name] = checkbox.checked;
    });
  }

  // Get selected theme
  let selectedTheme = 'auto';
  themeInputs.forEach(input => { if (input.checked) selectedTheme = input.value; });

  const settingsToSave = {
    folder: folderInput.value.trim() || DEFAULT_SETTINGS.folder,
    closeTabs: closeTabsInput.checked,
    allowedSites: allowedSites,
    theme: selectedTheme
  };

  console.log('Saving settings:', settingsToSave);

  chrome.storage.local.set(settingsToSave, () => {
    if (chrome.runtime.lastError) {
      // Show error message in gold
      statusSpan.textContent = 'Failed to save changes!';
      statusSpan.style.color = '#FFD700'; // gold
      showStatusTemporarily();
      console.error('Error saving settings:', chrome.runtime.lastError);
      return;
    }
    // Show success message in green
    statusSpan.textContent = 'Changes saved!';
    statusSpan.style.color = '#bcdd00'; // green
    showStatusTemporarily();
    saveButton.blur();
    saveButton.style.pointerEvents = 'none';
    setTimeout(() => {
      saveButton.style.pointerEvents = '';
    }, 1500);
  });
}

function showStatusTemporarily() {
  statusSpan.style.display = 'inline';
  setTimeout(() => {
    statusSpan.style.display = 'none';
  }, 5000);
}

/**
 * Restores options from chrome.storage.local, falling back to defaults.
 */
function restoreOptions() {
  chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
    if (chrome.runtime.lastError) {
      console.error('Error restoring settings:', chrome.runtime.lastError);
      return;
    }
    console.log('Restored settings:', result);
    folderInput.value = result.folder;
    closeTabsInput.checked = result.closeTabs;
    populateSitesList(result.allowedSites);
    // Restore theme radio
    themeInputs.forEach(input => { input.checked = (input.value === (result.theme || 'auto')); });
  });
}

/**
 * Populates the sites list with checkboxes from storage.
 * @param {object} sites - The allowedSites object from storage.
 */
function populateSitesList(sites) {
  sitesListDiv.innerHTML = ''; // Clear existing list

  const siteKeys = Object.keys(sites);
  const allSitesKey = 'all_sites';

  // Create and append checkboxes for all specific sites first, sorted alphabetically
  siteKeys.filter(site => site !== allSitesKey).forEach(site => {
    const entry = createCheckbox(site, site, sites[site]);
    sitesListDiv.appendChild(entry.div);
  });

  // Create and append the 'All websites' checkbox last
  if (siteKeys.includes(allSitesKey)) {
    const allSitesEntry = createCheckbox(allSitesKey, 'All websites', sites[allSitesKey]);
    sitesListDiv.appendChild(allSitesEntry.div);

    // Add the event listener to control all other checkboxes
    allSitesEntry.checkbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('#sites-list input[type="checkbox"]').forEach(cb => {
        // Don't toggle the 'All sites' checkbox itself
        if (cb.name !== allSitesKey) {
          cb.checked = isChecked;
        }
      });
    });
  }
}

/**
 * Helper function to create a checkbox and its label.
 * @param {string} name - The name/ID for the input.
 * @param {string} labelText - The text for the label.
 * @param {boolean} isChecked - Whether the checkbox should be checked.
 * @returns {{div: HTMLElement, checkbox: HTMLInputElement}}
 */
function createCheckbox(name, labelText, isChecked) {
  const div = document.createElement('div');
  div.className = 'form-group checkbox-group';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `site-${name.replace('.', '-')}`;
  checkbox.name = name;
  checkbox.checked = isChecked;

  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  label.textContent = labelText;

  div.appendChild(checkbox);
  div.appendChild(label);

  return { div, checkbox };
}

// --- Theme logic: apply user/system theme ---
function setThemeClass(theme) {
  document.body.classList.remove('light', 'dark');
  // Set color-scheme property for Chrome compatibility (forces theme)
  document.body.style.removeProperty('color-scheme');
  if (theme === 'dark') {
    document.body.classList.add('dark');
    document.body.style.colorScheme = 'dark';
  } else if (theme === 'light') {
    document.body.classList.add('light');
    document.body.style.colorScheme = 'light';
  } else {
    // Auto: use system detection
    document.body.style.colorScheme = 'light dark';
    const isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    document.body.classList.toggle('light', isLight);
    document.body.classList.toggle('dark', !isLight);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => setThemeClass('auto'));
  }
}
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get({ theme: 'auto' }, (result) => {
    setThemeClass(result.theme);
  });
});

// Add event listeners
document.addEventListener('DOMContentLoaded', restoreOptions);
form.addEventListener('submit', saveOptions);
