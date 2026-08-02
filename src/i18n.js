// Interface (UI chrome) i18n loader - separate from the page-content
// translation feature. Each language's actual strings live in their own
// file under src/locales/ (see locales/en.js for the full key list);
// missing keys/languages fall back to English via t() below.
import en from "./locales/en.js";
import es from "./locales/es.js";
import it from "./locales/it.js";
import fr from "./locales/fr.js";
import de from "./locales/de.js";
import ru from "./locales/ru.js";
import ko from "./locales/ko.js";
import ja from "./locales/ja.js";
import zh from "./locales/zh.js";

export const UI_STRINGS = { en, es, it, fr, de, ru, ko, ja, zh };

export const UI_FLAGS = {
  en: "\u{1F1EC}\u{1F1E7}", // GB flag
  es: "\u{1F1EA}\u{1F1F8}",
  it: "\u{1F1EE}\u{1F1F9}",
  fr: "\u{1F1EB}\u{1F1F7}",
  de: "\u{1F1E9}\u{1F1EA}",
  ru: "\u{1F1F7}\u{1F1FA}",
  ko: "\u{1F1F0}\u{1F1F7}",
  ja: "\u{1F1EF}\u{1F1F5}",
  zh: "\u{1F1E8}\u{1F1F3}",
};

/** Best-effort 2-letter language code from the browser's own UI language. */
export function detectBrowserLanguage() {
  const raw = (typeof navigator !== "undefined" && (navigator.language || navigator.userLanguage)) || "en";
  return raw.slice(0, 2).toLowerCase();
}

/**
 * Looks up a UI string by key for the given interface language, falling
 * back to English if the language or key is missing, and substituting any
 * {0}, {1}, ... placeholders with the given args (used for dynamic bits
 * like an HTTP status code or a raw error message).
 */
export function t(lang, key, ...args) {
  const strings = UI_STRINGS[lang] || UI_STRINGS.en;
  let str = strings[key] ?? UI_STRINGS.en[key] ?? key;
  args.forEach((arg, i) => {
    str = str.replace(`{${i}}`, arg);
  });
  return str;
}
