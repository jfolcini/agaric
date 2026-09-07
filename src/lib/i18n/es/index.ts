/**
 * The Spanish catalog — the whole of it, in one lazily-loaded chunk.
 *
 * Reached only through `loadLocale('es')` in `src/lib/i18n/index.ts`, which
 * `import()`s this module. Nothing imports it statically, so Rolldown emits
 * it as its own chunk and an English user never downloads or parses a byte
 * of it. Same trick, and the same reason, as the emoji dataset in
 * `src/components/EmojiPicker/EmojiPicker.tsx`: this is a same-bundle
 * dynamic `import()`, not a network fetch — Tauri serves everything from
 * disk, so there is no offline failure mode.
 *
 * Namespaces are partial by design. A key with no Spanish value is not an
 * error: i18next's `fallbackLng: 'en'` renders the English string, and
 * English is statically bundled so that fallback can never fail to load.
 * Namespaces land one translation PR at a time.
 *
 * The `date-fns` Spanish locale is registered here, into the leaf registry
 * in `locales.ts`, for exactly the same reason the strings live here: a
 * static import would put Spanish month and weekday vocabulary in the
 * startup chunk for every user. Registering it from inside this chunk keeps
 * UI language and date language switching together, in one payload.
 */

import { es as esDateFns } from 'date-fns/locale/es'

import { errors } from '@/lib/i18n/es/errors'
import { settings } from '@/lib/i18n/es/settings'
import { registerDateLocale } from '@/lib/i18n/locales'

registerDateLocale('es', esDateFns)

export const es: Record<string, string> = {
  ...errors,
  ...settings,
}
