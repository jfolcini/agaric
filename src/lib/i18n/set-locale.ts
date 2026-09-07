/**
 * `setLocale` and its lazy catalog loader (#4555), deliberately NOT in
 * `src/lib/i18n/index.ts`.
 *
 * That module is imported by **206 files** — its own docblock says so, and
 * refuses an edge to `@/lib/preferences` on exactly this ground: what it
 * imports, almost every consumer imports. A dynamic `import()` is the same
 * hazard in a different currency. Living in `index.ts`, the `es` chunk
 * boundary was pulled into all 206 module graphs to serve the TWO callers
 * that need it (`src/main.tsx` and `useLanguage`), and under `--coverage`
 * that is not free.
 *
 * Measured (#4818), same `src/components/agenda` subset, nothing to do with
 * i18n, `--maxWorkers=2`:
 *
 * | | without `--coverage` | with `--coverage` |
 * |---|---|---|
 * | before this locale work | 19.03s | 23.86s |
 * | with the loader in `index.ts` | 19.75s (+3.8%, noise) | 27.59s (**+15.6%**) |
 *
 * On CI that pushed `validate / vitest` from a ~14m10s baseline (#4806 14m07s,
 * #4807 14m23s) past its `timeout-minutes: 20`: cancelled four times at
 * 19m45s+, which surfaces as `validate-all: failure` with nothing naming the
 * clock. Splitting the file puts the chunk boundary in the two graphs that
 * actually want it.
 */

import { i18n } from '@/lib/i18n'
import { DEFAULT_LOCALE, type SupportedLocale } from '@/lib/i18n/locales'
import { logger } from '@/lib/logger'

/**
 * In-flight / settled locale loads, keyed by locale tag. Memoized so the
 * chunk is fetched and merged once no matter how many callers ask, and so a
 * double-fired select can't race two `addResourceBundle` calls.
 *
 * A REJECTED load is evicted rather than cached, so a retry (the user
 * picking the language again) actually retries — the same recovery shape
 * `EmojiPicker` gives its dataset load.
 */
const localeLoads = new Map<SupportedLocale, Promise<void>>()

/** Locale tag → its lazy chunk. `en` is absent: it is bundled above. */
const LOCALE_LOADERS: Record<
  Exclude<SupportedLocale, 'en'>,
  () => Promise<Record<string, string>>
> = {
  es: async () => (await import('@/lib/i18n/es')).es,
}

/**
 * Fetch a locale's catalog chunk and merge it into i18next. No-op for
 * `en` (statically bundled) and for an already-loaded locale.
 *
 * Rejects if the chunk fails to load. `setLocale` is the call site that
 * decides what that means for the user; this function stays honest about
 * the failure rather than silently leaving the language unchanged.
 */
export async function loadLocale(lng: SupportedLocale): Promise<void> {
  if (lng === DEFAULT_LOCALE) return
  const existing = localeLoads.get(lng)
  if (existing !== undefined) return existing
  const load = LOCALE_LOADERS[lng]()
    .then((catalog) => {
      // `deep`/`overwrite` false: a bundle is merged once, and a locale
      // never overwrites keys it already carries.
      i18n.addResourceBundle(lng, 'translation', catalog, false, false)
    })
    .catch((err: unknown) => {
      localeLoads.delete(lng)
      throw err
    })
  localeLoads.set(lng, load)
  return load
}

/**
 * The locale of the most recent `setLocale` call. An earlier call whose
 * catalog settles after a later one must not apply: `en` is bundled and
 * every other locale is a chunk, so an abandoned Spanish load reliably
 * resolves LAST and would otherwise leave a Spanish UI under a Settings
 * select reading "English" (#4812).
 */
let latestRequest: SupportedLocale = DEFAULT_LOCALE

/**
 * Switch the app's language: load the catalog, then change it. Awaiting the
 * chunk BEFORE `changeLanguage` is what makes the switch atomic — otherwise
 * the UI would flash a fully-English render between the two. A load
 * superseded by a newer `setLocale` while it was in flight is dropped
 * instead of applied, so switching twice mid-load lands on the locale the
 * user asked for last (#4812).
 *
 * A failed chunk load leaves the current language in place and logs; the
 * user keeps a working UI in the language they already had, which is a
 * better outcome than a half-switched one. There is NO user-visible feedback,
 * and the earlier claim that the Settings select provides it was wrong: that
 * select is bound to the STORED preference, which `setLanguage` wrote before
 * this ran, so it reads the language that failed to load while the UI stays
 * in the old one. Worth surfacing when a second catalog makes the failure
 * reachable in practice; today the only chunk is bundled beside the code
 * importing it.
 *
 * The stored preference is read by the CALLERS (`src/main.tsx` at boot,
 * `useLanguage` afterwards), not here. This module is imported by almost
 * everything, including `src/test-setup.ts`; giving it an edge to
 * `@/lib/preferences` pulls `useLocalStoragePreference` — and React — into
 * every consumer's module graph, which is enough to break an unrelated
 * suite that mocks `react` (it evaluates during setup, before the mock is
 * registered).
 */
export async function setLocale(lng: SupportedLocale): Promise<void> {
  latestRequest = lng
  try {
    await loadLocale(lng)
  } catch (err) {
    logger.error(
      'i18n',
      'failed to load locale catalog; staying on the current language',
      { lng },
      err,
    )
    return
  }
  if (latestRequest !== lng) return
  await i18n.changeLanguage(lng)
}
