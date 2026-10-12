// Shared dark/light theme handling for sidebar.html (and the popup built from it).
// Classic (non-module) script so it can be loaded the same way on every
// page regardless of whether that page's own script is a module. Defaults
// to dark on first run (no OS-preference detection).
(function () {
  const brw = typeof browser !== "undefined" ? browser : chrome;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Lucide "sun" / "moon" (ISC). Drawn as SVG rather than emoji so the icon
  // looks the same on every OS and can be coloured per theme from CSS.
  const ICONS = {
    sun: [
      ["circle", { cx: "12", cy: "12", r: "4", class: "theme-icon-fill" }],
      ["path", { d: "M12 2v2" }], ["path", { d: "M12 20v2" }],
      ["path", { d: "m4.93 4.93 1.41 1.41" }], ["path", { d: "m17.66 17.66 1.41 1.41" }],
      ["path", { d: "M2 12h2" }], ["path", { d: "M20 12h2" }],
      ["path", { d: "m6.34 17.66-1.41 1.41" }], ["path", { d: "m19.07 4.93-1.41 1.41" }],
    ],
    moon: [
      ["path", { d: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401", class: "theme-icon-fill" }],
    ],
  };

  function themeIcon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = {
      viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    svg.setAttribute("class", `theme-icon theme-icon-${name}`);
    for (const [tag, nodeAttrs] of ICONS[name]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(nodeAttrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  function renderToggle() {
    const toggleBtn = document.getElementById("themeToggle");
    if (!toggleBtn) return;
    // Icon shows the mode you'll switch *to*. The (localized) title is
    // set by sidebar.js.
    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    toggleBtn.replaceChildren(themeIcon(theme === "dark" ? "sun" : "moon"));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    renderToggle();
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    brw.storage.local.set({ theme: next });
  }

  // Dark until the stored choice arrives (avoids a light flash).
  document.documentElement.setAttribute("data-theme", "dark");
  brw.storage.local.get(["theme"]).then((settings) => {
    applyTheme(settings.theme || "dark");
  });

  document.addEventListener("DOMContentLoaded", () => {
    renderToggle(); // the stored theme may have arrived before the button existed
    const toggleBtn = document.getElementById("themeToggle");
    if (toggleBtn) toggleBtn.addEventListener("click", toggleTheme);
  });
})();
