// Shared dark/light theme handling for sidebar.html.
// Classic (non-module) script so it can be loaded the same way on every
// page regardless of whether that page's own script is a module. Defaults
// to dark on first run (no OS-preference detection).
(function () {
  const brw = typeof browser !== "undefined" ? browser : chrome;

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const toggleBtn = document.getElementById("themeToggle");
    if (toggleBtn) {
      // Icon shows the mode you'll switch *to*.
      toggleBtn.textContent = theme === "dark" ? "\u2600\ufe0f" : "\ud83c\udf19";
      toggleBtn.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    brw.storage.local.set({ theme: next });
  }

  brw.storage.local.get(["theme"]).then((settings) => {
    applyTheme(settings.theme || "dark");
  });

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("themeToggle");
    if (toggleBtn) toggleBtn.addEventListener("click", toggleTheme);
  });
})();
