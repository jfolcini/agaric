/**
 * i18n namespace: settings — Spanish (`es`), partial.
 *
 * Only the language control this PR adds. The other ~207 `settings.*` keys
 * are untranslated on purpose and fall back to English (`fallbackLng: 'en'`)
 * until the `settings` namespace gets its own translation PR — see
 * `src/lib/i18n/index.ts` for the contributor rule.
 *
 * `settings.languageEnglish` / `settings.languageSpanish` are absent
 * deliberately rather than by omission: a language picker names each
 * language in that language ("English", "Español"), so the English catalog's
 * values are already correct here and overriding them would be a
 * regression, not a translation.
 */

export const settings: Record<string, string> = {
  'settings.languageLabel': 'Idioma',
  'settings.languageHelp':
    'Sistema usa el idioma de tu dispositivo. Lo que aún no esté traducido se muestra en inglés.',
  'settings.languageSystem': 'Sistema',
}
