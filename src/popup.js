// popup.js
// Logic for the extension's popup menu

/**
 * @file popup.js
 * @description Logic for the extension's popup menu, including showing download status.
 */

/**
 * Updates the status message in the popup based on data from chrome.storage.
 * This function centralizes the logic for displaying the correct status.
 */
function updateStatusMessage() {
  const statusDiv = document.getElementById('status-message');
  if (!statusDiv) return; // Exit if the status element doesn't exist

  // Fetch the current download state from storage.
  chrome.storage.local.get(['downloadInProgress', 'lastDownloadComplete'], (result) => {
    const now = Date.now();
    const oneHour = 3600 * 1000; // One hour in milliseconds

    // Case 1: A download is currently running.
    if (result.downloadInProgress) {
      statusDiv.textContent = 'Download in progress...';
      statusDiv.style.color = 'var(--accent-2)'; // Orange/Yellow
    }
    // Case 2: The last download finished within the last hour.
    else if (result.lastDownloadComplete && (now - result.lastDownloadComplete < oneHour)) {
      statusDiv.textContent = 'Download complete';
      statusDiv.style.color = 'var(--primary-2)'; // Green
    }
    // Case 3: No recent or active downloads.
    else {
      statusDiv.textContent = ''; // Clear the message
    }
  });
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

// --- Event Listeners ---

// 1. When the popup HTML has loaded.
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get({ theme: 'auto' }, (result) => {
    setThemeClass(result.theme);
  });

  // Immediately check and display the current download status.
  updateStatusMessage();

  // Add click listener for the 'Scan & Download' button.
  document.getElementById('scan-button').addEventListener('click', () => {
    // Send a command to the background script to start the process.
    chrome.runtime.sendMessage({ command: 'scan-all-tabs' });
    // Immediately update the UI to show that the download has started.
    const statusDiv = document.getElementById('status-message');
    if (statusDiv) {
      statusDiv.textContent = 'Download in progress...';
      statusDiv.style.color = 'var(--accent-2)';
    }
  });

  // Add click listener for the 'Settings' button.
  document.getElementById('settings-button').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});

// 2. Listen for messages from the background script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if the message indicates that the download queue is complete.
  if (message && message.type === 'download-complete') {
    // Update the status message to show 'Download complete'.
    updateStatusMessage();

    // After 5 seconds, re-run the status check. This ensures the message
    // stays accurate if a new download starts or if an hour has passed.
    setTimeout(() => {
      updateStatusMessage();
    }, 5000);
  }
});
