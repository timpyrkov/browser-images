// Single source of truth for languages the extension currently supports.
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "ru", name: "Russian" },
  { code: "ko", name: "Korean" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
];

export const LANGUAGE_NAMES = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.code, lang.name])
);
