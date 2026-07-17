/**
 * preferences.ts — the typed, central registry of localStorage-backed app
 * preferences.
 *
 * ## Contract: per-device, non-synced
 *
 * Every preference registered here is **device-local only**. These values
 * live in `localStorage` and deliberately **never sync between devices** — no
 * IPC, no block property, no server round-trip. A user's density/sort choice
 * on their laptop is independent of the same choice on their desktop, and a
 * fresh install starts from `defaultValue`. This is by design (mirrors
 * `tag-colors.ts` / `starred-pages.ts`): these are chrome/ergonomics knobs,
 * not document data, so cross-device drift is acceptable and expected.
 *
 * ## Scope
 *
 * - `scope: 'device'` — one value per device. The localStorage key is the
 *   `key` verbatim.
 * - `scope: 'space'` — one value per (device, space). The effective key is
 *   `${key}:${spaceId}`; callers must pass the active `spaceId`.
 * - `scope: 'page'` — one value per (device, page). Same key computation as
 *   `'space'` (`${key}:${pageKey}`) but keyed by a page root id instead of a
 *   space id — e.g. per-page collapsed-block state (`PREFERENCES.blockCollapse`).
 *   This is a distinct axis from device/sync scope (see module docstring,
 *   "Adding a preference"): it documents WHICH runtime id partitions the
 *   value, not whether it syncs.
 *
 * `readPreference`/`writePreference`/`hasPreference`/`removePreference` all
 * take the same optional second argument (a `spaceId` for `'space'`, a
 * `pageKey` for `'page'`, ignored for `'device'`) — one accessor family
 * covers both keyed axes, so a new per-space or per-page preference never
 * needs a parallel "family" API.
 *

 * ## Storage format (no envelope)
 *
 * Values are stored in the **same bare format the key already used** — no
 * version wrapper, no JSON envelope around the payload. This keeps every
 * existing user's stored data working with zero forced migration. `version`
 * is *contract metadata* (documentation of the current shape), NOT a stored
 * field. When you genuinely change a key's on-disk shape, bump `version` and
 * supply a `migrate` transform.
 *
 * ## Migration (opt-in, migrate-on-read)
 *
 * `migrate(rawStored)` runs on read, BEFORE `parse`, and transforms a legacy
 * raw string into the current raw form (or returns `null` to discard it and
 * fall back to `defaultValue`). This mirrors the migrate-on-read model in
 * `tag-colors.ts` (`migrateTagColors`). The migrated value is re-persisted in
 * the current format on the next write (the mount-effect in
 * `useLocalStoragePreference` handles this for the hook path).
 *
 * ## Change notification (#2666)
 *
 * `writePreference` / `removePreference` broadcast every successful write
 * via `broadcastPreferenceChange` (a synthetic `StorageEvent` — the
 * app-wide same-tab convention; other windows receive the native event).
 * `useLocalStoragePreference` — and therefore `usePreference` — subscribes
 * per key, so every mounted hook instance re-reads after ANY registry
 * write, whether it came from another hook instance or a non-hook lib
 * writer (e.g. `starred-pages.ts`). Pre-existing raw `storage` listeners
 * (`keyboard-config`, `HelpTab`, `useQuickCaptureShortcut`) keep working
 * unchanged and gain same-tab coverage.
 *
 * ## Failure discipline
 *
 * The pure helpers (`readPreference` / `writePreference`) and the
 * `usePreference` hook share the same defensive posture as
 * `useLocalStoragePreference`:
 *   1. SSR / no `window` → return `defaultValue`, no storage access.
 *   2. Read throws (private mode, locked-down webview) → `defaultValue` + warn.
 *   3. `migrate`/`parse` throws or yields invalid data → `defaultValue`
 *      (silent — invalid stored data is expected after a format change).
 *   4. Write throws (quota, private mode) → swallow + warn.
 *
 * `readPreference` never hands back a *shared reference* to `defaultValue`
 * on the "nothing stored" branch — several migrated call sites (starred
 * pages, tag colors, recent-searches/-commands, block-collapse ids) read a
 * fresh array/object and mutate it in place (`pages.push(id)`) before
 * writing it back, exactly like the pre-registry code (which always parsed
 * a fresh value out of `JSON.parse`). Returning `defaultValue` by reference
 * would let that in-place mutation corrupt the shared default for every
 * future "key absent" read across every caller of that `PreferenceDefinition`
 * — `cloneDefault` (shallow; every default here is a flat array or a flat
 * string-keyed record) keeps the "always a fresh value" contract for the
 * default branch too.
 *
 * `hasPreference` answers "is there ANY stored value" (including one that
 * fails to `parse`) — distinct from `readPreference(def) !== def.defaultValue`,
 * which can't tell "never stored" apart from "stored, and happens to equal
 * the default" (e.g. an explicitly-persisted empty array). `useBlockCollapse`
 * needs exactly this: a page that scoped-wrote an empty collapsed-ids list
 * (everything expanded) must not fall through to the legacy global key, so it
 * checks `hasPreference` rather than comparing the read value to `[]`.
 *
 * `removePreference` clears a stored value outright (vs. writing the
 * default) — used where "never configured" is a distinct, meaningful state
 * from "explicitly reset" (e.g. `clearPathHistory`, `resetOnboardingSeen`).
 *
 * ## Adding a preference
 *
 * New localStorage-backed preferences MUST be registered here as a
 * `PreferenceDefinition` and consumed via `usePreference` /
 * `readPreference` / `writePreference` so all app preferences stay
 * discoverable in one place, with a single naming/versioning/migration
 * contract. Keep the existing `key` string verbatim when migrating an
 * ad-hoc preference into the registry — do NOT re-key it, or you orphan every
 * existing user's stored value.
 */

import {
  broadcastPreferenceChange,
  useLocalStoragePreference,
} from '@/hooks/useLocalStoragePreference'
import { logger } from '@/lib/logger'

export interface PreferenceDefinition<T> {
  /** The localStorage key base. Kept verbatim — never re-keyed. */
  key: string
  /**
   * `'device'` → the effective key is `key` as-is. `'space'` / `'page'` →
   * the effective key is `${key}:${keyArg}` (a `spaceId` or `pageKey`
   * respectively) and callers must supply that second argument. See the
   * module docstring's "Scope" section.
   */
  scope: 'device' | 'space' | 'page'
  /**
   * Contract metadata describing the current on-disk shape. NOT a stored
   * envelope. Bump this (and add a `migrate`) when the raw format changes.
   */
  version: number
  /** Returned whenever nothing valid is stored. */
  defaultValue: T
  /** Parse the raw stored string into a value. Throws on invalid input. */
  parse: (raw: string) => T
  /** Serialize a value back to its raw stored string. */
  serialize: (value: T) => string
  /**
   * Migrate-on-read (optional): transform a legacy raw string into the
   * current raw form, or return `null` to discard it (→ `defaultValue`).
   * Runs BEFORE `parse`. Mirrors the `tag-colors.ts` migration model.
   */
  migrate?: (rawStored: string) => string | null
}

/**
 * Compute the effective localStorage key for a definition.
 *
 * - `device` scope: `def.key` verbatim (`keyArg` is ignored).
 * - `space` / `page` scope: `${def.key}:${keyArg}`. If a keyed definition is
 *   used without a `keyArg`, we take the safe route — warn and fall back to
 *   the bare `def.key` rather than throwing into a render/click path.
 */
export function effectiveKey<T>(def: PreferenceDefinition<T>, keyArg?: string): string {
  if (def.scope === 'device') return def.key
  if (keyArg === undefined || keyArg === '') {
    const argName = def.scope === 'space' ? 'spaceId' : 'pageKey'
    logger.warn(
      `preference:${def.key}`,
      `${def.scope === 'space' ? 'Space' : 'Page'}-scoped preference used without a ${argName}; falling back to bare key`,
      { key: def.key },
    )
    return def.key
  }
  return `${def.key}:${keyArg}`
}

/**
 * Shallow-clone a default value before handing it back to a caller. See the
 * module docstring's "Failure discipline" section for why — array/object
 * defaults are single literals shared across every "key absent" read, and
 * several migrated call sites mutate the returned value in place before
 * writing it back. Shallow is sufficient: every default in this module is a
 * flat array or a flat string-keyed record.
 */
function cloneDefault<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (value !== null && typeof value === 'object') return { ...(value as object) } as T
  return value
}

/**
 * Read a preference value directly (non-hook). SSR-safe; applies `migrate`
 * before `parse`; falls back to `def.defaultValue` on any failure.
 */
export function readPreference<T>(def: PreferenceDefinition<T>, keyArg?: string): T {
  if (typeof window === 'undefined') return cloneDefault(def.defaultValue)
  const key = effectiveKey(def, keyArg)
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return cloneDefault(def.defaultValue)
    try {
      const migrated = def.migrate ? def.migrate(raw) : raw
      // migrate → null means "discard the legacy value".
      if (migrated === null) return cloneDefault(def.defaultValue)
      return def.parse(migrated)
    } catch {
      // Invalid / undecodable stored data — fall back silently. Expected on
      // the first read after a format change (see module docstring).
      return cloneDefault(def.defaultValue)
    }
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to read localStorage preference', { key }, err)
    return cloneDefault(def.defaultValue)
  }
}

/**
 * Write a preference value directly (non-hook). SSR-safe; swallows and warns
 * on any storage failure (quota, private mode, locked-down webview). On
 * success, broadcasts the change (see module docstring, "Change
 * notification") so every mounted `usePreference` /
 * `useLocalStoragePreference` instance for the key re-reads.
 */
export function writePreference<T>(def: PreferenceDefinition<T>, value: T, keyArg?: string): void {
  if (typeof window === 'undefined') return
  const key = effectiveKey(def, keyArg)
  try {
    const newValue = def.serialize(value)
    let oldValue: string | null = null
    try {
      oldValue = localStorage.getItem(key)
    } catch {
      // Reading the previous value is best-effort broadcast metadata.
    }
    localStorage.setItem(key, newValue)
    broadcastPreferenceChange(key, oldValue, newValue)
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to write localStorage preference', { key }, err)
  }
}

/**
 * True when the key has ANY stored value (including one that fails to
 * `parse`). Distinct from `readPreference(def) !== def.defaultValue` — a
 * caller that needs to tell "never stored" apart from "stored, and happens
 * to equal the default" (e.g. an explicitly-persisted empty array) should
 * use this instead. SSR-safe; a read throw degrades to `false` (+ warn)
 * rather than propagating.
 */
export function hasPreference<T>(def: PreferenceDefinition<T>, keyArg?: string): boolean {
  if (typeof window === 'undefined') return false
  const key = effectiveKey(def, keyArg)
  try {
    return localStorage.getItem(key) !== null
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to read localStorage preference', { key }, err)
    return false
  }
}

/**
 * Remove a preference's stored value outright (as opposed to writing
 * `defaultValue` back). SSR-safe; swallows and warns on any storage failure.
 */
export function removePreference<T>(def: PreferenceDefinition<T>, keyArg?: string): void {
  if (typeof window === 'undefined') return
  const key = effectiveKey(def, keyArg)
  try {
    let oldValue: string | null = null
    try {
      oldValue = localStorage.getItem(key)
    } catch {
      // Reading the previous value is best-effort broadcast metadata.
    }
    localStorage.removeItem(key)
    broadcastPreferenceChange(key, oldValue, null)
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to remove localStorage preference', { key }, err)
  }
}

/**
 * React hook binding a `PreferenceDefinition` to state. Delegates all the
 * SSR-guard / try-catch / persistence machinery to `useLocalStoragePreference`
 * — this wrapper only resolves the effective key, applies `migrate` on the
 * initial read (by composing it ahead of `def.parse`), and labels logs.
 */
export function usePreference<T>(
  def: PreferenceDefinition<T>,
  keyArg?: string,
): [T, (value: T | ((prev: T) => T)) => void] {
  const key = effectiveKey(def, keyArg)
  // `useLocalStoragePreference` invokes `parse` whenever the raw stored
  // string changes (initial read + every broadcast re-read), so composing
  // `migrate` ahead of it applies the legacy → current transform on every
  // read of a legacy raw value. A `null` from `migrate` (discard) is
  // surfaced as a throw so the shared hook's parse-failure path resets to
  // `defaultValue`.
  const parse = (raw: string): T => {
    const migrated = def.migrate ? def.migrate(raw) : raw
    if (migrated === null) throw new Error('preference migrate: discarded legacy value')
    return def.parse(migrated)
  }
  // `cloneDefault` — see the module docstring's "Failure discipline" section:
  // `useLocalStoragePreference` captures this value on first render and
  // hands it back by reference on "key absent", same hazard as
  // `readPreference`'s default branch.
  return useLocalStoragePreference<T>(key, cloneDefault(def.defaultValue), {
    parse,
    serialize: def.serialize,
    source: `preference:${def.key}`,
  })
}

// ── Concrete definitions ───────────────────────────────────────────────────
//
// The `DensityMode` / `SortOption` domain types are DEFINED here (not in the
// hooks) and re-exported by `usePageBrowserDensity` / `usePageBrowserSort` for
// their public API. The hooks import the preference *values* from this module,
// so if this module imported the types back from the hooks — even type-only —
// the import-cycle guard (`scripts/check-import-cycles.mjs`, which counts
// `import type` edges) would flag a cycle. Owning the types here keeps every
// edge pointing one way: hooks → preferences.

/** Pages view row-chrome density. */
export type DensityMode = 'compact' | 'regular' | 'expanded'

/** Pages view sort option. 3 legacy + 4 new. */
export type SortOption =
  | 'alphabetical'
  | 'recent'
  | 'created'
  | 'recently-modified'
  | 'most-linked'
  | 'most-content'
  | 'default'

const ALL_DENSITIES: ReadonlyArray<DensityMode> = ['compact', 'regular', 'expanded']

/**
 * Allowlist guard for the `page-browser-density` value. Throws on anything
 * outside the known modes so callers reset to the default.
 */
function parseDensity(raw: string): DensityMode {
  if ((ALL_DENSITIES as readonly string[]).includes(raw)) return raw as DensityMode
  throw new Error(`invalid density: ${raw}`)
}

const ALL_SORTS: ReadonlyArray<SortOption> = [
  'alphabetical',
  'recent',
  'created',
  'recently-modified',
  'most-linked',
  'most-content',
  'default',
]

/**
 * Allowlist guard for the `page-browser-sort` value. The legacy storage
 * format is the bare option string (e.g. `alphabetical`), not JSON — so we
 * parse/serialize the bare value and throw on anything outside the allowlist
 * so unknown/future values reset to the default.
 */
function parseSort(raw: string): SortOption {
  if ((ALL_SORTS as readonly string[]).includes(raw)) return raw as SortOption
  throw new Error(`invalid sort option: ${raw}`)
}

/** Identity serializer — density/sort persist as the bare option string. */
function identity<T extends string>(value: T): string {
  return value
}

/** Week start day: 0 = Sunday, 1 = Monday (the default). */
export type WeekStartDay = 0 | 1

/**
 * `week-start-preference` — first day of the week for calendar/agenda views
 * (`src/hooks/useWeekStart.ts`). Bare-string format (`'0'` / `'1'`).
 * Legacy contract (pre-registry `useWeekStart`): the literal `'0'` means
 * Sunday, ANY other stored value — including garbage — means Monday, so
 * `parse` never throws.
 */
const WEEK_START_PREFERENCE: PreferenceDefinition<WeekStartDay> = {
  key: 'week-start-preference',
  scope: 'device',
  version: 1,
  defaultValue: 1,
  parse: (raw) => (raw === '0' ? 0 : 1),
  serialize: (value) => String(value),
}

/**
 * Allowed journal-title display formats (#1448, `useJournalDateFormat`).
 *
 * - `'locale'` is a sentinel for the app's pre-existing localized rendering
 *   (`formatDateDisplay`, e.g. "Mon, Jun 17 2026"). It is the DEFAULT, so the
 *   journal title looks exactly as it did before this feature — nothing changes
 *   for existing users.
 * - The remaining entries are date-fns format token strings (the same dialect
 *   already used across `date-utils.ts`). `'yyyy-MM-dd'` reproduces the canonical
 *   stored ISO shape, so formatting under it is an identity transform.
 */
export const JOURNAL_DATE_FORMATS = [
  'locale',
  'yyyy-MM-dd',
  'MMMM d, yyyy',
  'dd/MM/yyyy',
  'EEE, MMM d',
] as const

export type JournalDateFormat = (typeof JOURNAL_DATE_FORMATS)[number]

/** Default: the existing localized rendering, so nothing changes for existing users. */
export const DEFAULT_JOURNAL_DATE_FORMAT: JournalDateFormat = 'locale'

/**
 * `journal-date-format` — the *display* format of journal page titles
 * (`src/hooks/useJournalDateFormat.ts`). Bare-string format validated
 * against the {@link JOURNAL_DATE_FORMATS} allowlist; unknown values reset
 * to the localized default.
 */
const JOURNAL_DATE_FORMAT_PREFERENCE: PreferenceDefinition<JournalDateFormat> = {
  key: 'journal-date-format',
  scope: 'device',
  version: 1,
  defaultValue: DEFAULT_JOURNAL_DATE_FORMAT,
  parse: (raw) => {
    if ((JOURNAL_DATE_FORMATS as readonly string[]).includes(raw)) return raw as JournalDateFormat
    throw new Error(`invalid journal date format: ${raw}`)
  },
  serialize: identity,
}

/**
 * `page-browser-density` — the Pages view row-chrome density. Device-scoped,
 * bare-string format (no JSON envelope), matching the pre-registry on-disk
 * shape so existing users' stored values keep working untouched.
 */
const DENSITY_PREFERENCE: PreferenceDefinition<DensityMode> = {
  key: 'page-browser-density',
  scope: 'device',
  version: 1,
  defaultValue: 'regular',
  parse: parseDensity,
  serialize: identity,
}

/**
 * `page-browser-sort` — the Pages view sort option. Device-scoped, bare-string
 * format (no JSON envelope), matching the pre-registry on-disk shape.
 */
const SORT_PREFERENCE: PreferenceDefinition<SortOption> = {
  key: 'page-browser-sort',
  scope: 'device',
  version: 1,
  defaultValue: 'alphabetical',
  parse: parseSort,
  serialize: identity,
}

// ── JSON helpers for entries whose wire format is a plain
// `JSON.stringify`/`JSON.parse` round-trip. ─────────────────────────────
const jsonParse = <T>(raw: string): T => JSON.parse(raw) as T
const jsonSerialize = <T>(value: T): string => JSON.stringify(value)

/**
 * `agaric-gesture-coachmark-seen` — first-run mobile gesture coach-mark
 * dismissed (`src/lib/gesture-coachmark.ts`). Legacy format: presence of
 * ANY value means "seen" (always written as the literal string `'true'`,
 * but the original reader was `!!raw`).
 */
const GESTURE_COACHMARK_SEEN_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric-gesture-coachmark-seen',
  scope: 'device',
  version: 1,
  defaultValue: false,
  parse: () => true,
  serialize: () => 'true',
}

/**
 * `agaric-onboarding-done` — first-run welcome modal dismissed
 * (`src/lib/onboarding.ts`). Same presence-means-seen legacy format as
 * `gestureCoachmarkSeen`.
 */
const ONBOARDING_DONE_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric-onboarding-done',
  scope: 'device',
  version: 1,
  defaultValue: false,
  parse: () => true,
  serialize: () => 'true',
}

/**
 * `agaric:space-onboarding-seen-v1` — manage-spaces dialog onboarding banner
 * dismissed (`src/components/SpaceManageDialog/SpaceOnboardingHint.tsx`). Do
 * NOT rename — pre-existing users have this exact key set; renaming would
 * re-show the banner after upgrade. Exact-match `'true'` (not mere
 * presence) — mirrors the original reader.
 */
const SPACE_ONBOARDING_SEEN_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric:space-onboarding-seen-v1',
  scope: 'device',
  version: 1,
  defaultValue: false,
  parse: (raw) => raw === 'true',
  serialize: () => 'true',
}

/** `tag-colors` — tag id -> CSS color/accent-token map (`src/lib/tag-colors.ts`). */
const TAG_COLORS_PREFERENCE: PreferenceDefinition<Record<string, string>> = {
  key: 'tag-colors',
  scope: 'device',
  version: 1,
  defaultValue: {} as Record<string, string>,
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v
    }
    return result
  },
  serialize: jsonSerialize<Record<string, string>>,
}

/**
 * `pinned_search_scope` — pinned default segment for the mobile search sheet
 * (`src/lib/pinned-search-scope.ts`). Empty string on disk = "no pin".
 */
const PINNED_SEARCH_SCOPE_PREFERENCE: PreferenceDefinition<'in-page' | 'all-pages' | null> = {
  key: 'pinned_search_scope',
  scope: 'device',
  version: 1,
  defaultValue: null,
  parse: (raw) => {
    if (raw === 'in-page' || raw === 'all-pages') return raw
    throw new Error(`invalid pinned search scope: ${raw}`)
  },
  serialize: (value) => value ?? '',
}

/**
 * `agaric-emoji-picker-enabled` — inline `:` emoji picker enabled
 * (`src/lib/editor-preferences.ts`). Default true (absent/corrupt -> on).
 * Legacy semantics: anything other than a JSON-encoded `false` counts as
 * enabled.
 */
const EMOJI_PICKER_ENABLED_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric-emoji-picker-enabled',
  scope: 'device',
  version: 1,
  defaultValue: true,
  parse: (raw) => (JSON.parse(raw) as unknown) !== false,
  serialize: jsonSerialize<boolean>,
}

/**
 * `agaric-tab-indents-blocks` — Tab/Shift+Tab indents blocks
 * (`src/lib/editor-preferences.ts`). Default true.
 */
const TAB_INDENTS_BLOCKS_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric-tab-indents-blocks',
  scope: 'device',
  version: 1,
  defaultValue: true,
  parse: (raw) => (JSON.parse(raw) as unknown) !== false,
  serialize: jsonSerialize<boolean>,
}

/** `starred-pages` — starred (favorited) page ids (`src/lib/starred-pages.ts`). */
const STARRED_PAGES_PREFERENCE: PreferenceDefinition<string[]> = {
  key: 'starred-pages',
  scope: 'device',
  version: 1,
  defaultValue: [] as string[],
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  },
  serialize: jsonSerialize<string[]>,
}

/**
 * `agaric:quickCaptureShortcut` — user-configured global-shortcut
 * accelerator (`src/lib/quick-capture-shortcut.ts`). Empty string sentinel =
 * "not set".
 */
const QUICK_CAPTURE_SHORTCUT_PREFERENCE: PreferenceDefinition<string> = {
  key: 'agaric:quickCaptureShortcut',
  scope: 'device',
  version: 1,
  defaultValue: '',
  parse: (raw) => raw,
  serialize: (value) => value,
}

/**
 * `sidebar_width` — sidebar drag-resize width in px
 * (`src/components/ui/sidebar/use-sidebar-state.ts`). `-1` sentinel = "not
 * stored" (distinct from a genuine below-minimum value).
 */
const SIDEBAR_WIDTH_PREFERENCE: PreferenceDefinition<number> = {
  key: 'sidebar_width',
  scope: 'device',
  version: 1,
  defaultValue: -1,
  parse: (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error('not a number')
    return n
  },
  serialize: (value) => String(value),
}

/**
 * `agaric:searchFilterSyntaxToast:v1` — one-time "filter syntax is live"
 * toast shown (`src/components/SearchPanel/useFilterSyntaxIntroToast.ts`).
 */
const FILTER_SYNTAX_INTRO_TOAST_SHOWN_PREFERENCE: PreferenceDefinition<boolean> = {
  key: 'agaric:searchFilterSyntaxToast:v1',
  scope: 'device',
  version: 1,
  defaultValue: false,
  parse: () => true,
  serialize: () => '1',
}

/**
 * Animation-speed choices for the global motion knob
 * (`src/hooks/useMotionPreference.ts`, surfaced in AppearanceTab).
 *
 * - `'system'` — DEFAULT. Write no inline `--motion-scale`; the CSS
 *   `prefers-reduced-motion` media query governs (full motion normally, none
 *   when the OS asks for reduced motion). Nothing changes for existing users.
 * - `'full'` — force full-speed motion (scale 1), overriding the OS flag.
 * - `'fast'` — half-duration motion (scale 0.5) for a snappier feel.
 * - `'off'` — instant, no motion (scale 0 + `data-motion='off'`).
 */
export type MotionPreference = 'system' | 'full' | 'fast' | 'off'

const ALL_MOTION_PREFERENCES: ReadonlyArray<MotionPreference> = ['system', 'full', 'fast', 'off']

/**
 * `agaric-motion` — global animation-speed knob
 * (`src/hooks/useMotionPreference.ts`). Device-scoped bare-string value
 * validated against the allowlist; unknown values reset to `'system'`.
 */
const MOTION_PREFERENCE: PreferenceDefinition<MotionPreference> = {
  key: 'agaric-motion',
  scope: 'device',
  version: 1,
  defaultValue: 'system',
  parse: (raw) => {
    if ((ALL_MOTION_PREFERENCES as readonly string[]).includes(raw)) return raw as MotionPreference
    throw new Error(`invalid motion preference: ${raw}`)
  },
  serialize: identity,
}

/** `agaric-font-size` — editor/UI font size (`src/components/settings/AppearanceTab.tsx`). */
const FONT_SIZE_PREFERENCE: PreferenceDefinition<'small' | 'medium' | 'large'> = {
  key: 'agaric-font-size',
  scope: 'device',
  version: 1,
  defaultValue: 'medium',
  parse: (raw) => {
    if (raw === 'small' || raw === 'medium' || raw === 'large') return raw
    throw new Error(`invalid font size: ${raw}`)
  },
  serialize: (value) => value,
}

/**
 * `agaric:deadlineWarningDays` — overdue-warning lead time in days
 * (`src/hooks/useDuePanelData.ts`,
 * `src/components/agenda/DeadlineWarningSection.tsx`). Legacy on-disk
 * format is a bare integer (not JSON).
 */
const DEADLINE_WARNING_DAYS_PREFERENCE: PreferenceDefinition<number> = {
  key: 'agaric:deadlineWarningDays',
  scope: 'device',
  version: 1,
  defaultValue: 0,
  parse: (raw) => {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) throw new Error('not a number')
    return n
  },
  serialize: (value) => String(value),
}

/**
 * `agaric:last-update-check` — ISO timestamp of the last successful update
 * check (`src/hooks/useUpdateCheck.ts`). `null` = never checked.
 */
const LAST_UPDATE_CHECK_PREFERENCE: PreferenceDefinition<string | null> = {
  key: 'agaric:last-update-check',
  scope: 'device',
  version: 1,
  defaultValue: null,
  parse: (raw) => raw,
  serialize: (value) => value ?? '',
}

/**
 * `agaric-settings-active-tab` — Settings panel's active tab
 * (`src/lib/url-state.ts`). Validated against `SettingsTab` by
 * `SettingsView` (this module deliberately stays feature-agnostic). Empty
 * string sentinel = "not stored".
 */
const SETTINGS_ACTIVE_TAB_PREFERENCE: PreferenceDefinition<string> = {
  key: 'agaric-settings-active-tab',
  scope: 'device',
  version: 1,
  defaultValue: '',
  parse: (raw) => raw,
  serialize: (value) => value,
}

/**
 * `collapsed_ids` — pre-#752 GLOBAL collapsed-block-id list
 * (`src/hooks/useBlockCollapse.ts`). Read-only migration fallback; never
 * written again. Distinct effective key from `blockCollapse` below despite
 * the same base `key` — this one is `device`-scoped (bare key), the other
 * `page`-scoped (`collapsed_ids:<pageKey>`).
 */
const BLOCK_COLLAPSE_LEGACY_PREFERENCE: PreferenceDefinition<string[]> = {
  key: 'collapsed_ids',
  scope: 'device',
  version: 1,
  defaultValue: [] as string[],
  parse: jsonParse<string[]>,
  serialize: jsonSerialize<string[]>,
}

/**
 * `agaric:pathHistory:v1:<spaceId>` — per-space MRU of `path:`/`not-path:`
 * globs (`src/lib/path-history.ts`). Space-keyed: pass the space id as the
 * second argument to `readPreference`/`writePreference`/`removePreference`.
 */
const PATH_HISTORY_PREFERENCE: PreferenceDefinition<string[]> = {
  key: 'agaric:pathHistory:v1',
  scope: 'space',
  version: 1,
  defaultValue: [] as string[],
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  },
  serialize: jsonSerialize<string[]>,
}

/**
 * `recent_searches:<spaceId>` — per-space MRU of recent search terms
 * (`src/lib/recent-searches.ts`). Space-keyed.
 */
const RECENT_SEARCHES_PREFERENCE: PreferenceDefinition<string[]> = {
  key: 'recent_searches',
  scope: 'space',
  version: 1,
  defaultValue: [] as string[],
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
  },
  serialize: jsonSerialize<string[]>,
}

/** A recently-run command entry (`src/lib/recent-commands.ts`). */
export interface RecentCommand {
  /** Stable command id (e.g. `go-settings`, `search-everywhere`). */
  id: string
  /** ISO timestamp of the most recent run. */
  runAt: string
}

function parseRecentCommands(raw: string): RecentCommand[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is RecentCommand =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['id'] === 'string' &&
      typeof (item as Record<string, unknown>)['runAt'] === 'string',
  )
}

/**
 * `recent_commands:<spaceId>` — per-space MRU of recently-run command-palette
 * ids (`src/lib/recent-commands.ts`). Space-keyed.
 */
const RECENT_COMMANDS_PALETTE_PREFERENCE: PreferenceDefinition<RecentCommand[]> = {
  key: 'recent_commands',
  scope: 'space',
  version: 1,
  defaultValue: [] as RecentCommand[],
  parse: parseRecentCommands,
  serialize: jsonSerialize<RecentCommand[]>,
}

/**
 * `recent_slash:<spaceId>` — #1105 the slash menu reuses `recent-commands.ts`
 * under its own namespace (distinct key prefix) so palette and slash command
 * ids never collide. Same shape/cap/move-to-top semantics as
 * `recentCommandsPalette`.
 */
const RECENT_COMMANDS_SLASH_PREFERENCE: PreferenceDefinition<RecentCommand[]> = {
  key: 'recent_slash',
  scope: 'space',
  version: 1,
  defaultValue: [] as RecentCommand[],
  parse: parseRecentCommands,
  serialize: jsonSerialize<RecentCommand[]>,
}

/**
 * `collapsed_ids:<pageKey>` — collapsed block ids, keyed by page root id
 * (#752, `src/hooks/useBlockCollapse.ts`). Page-keyed (not space-keyed) —
 * see `blockCollapseLegacy` above for the pre-#752 global fallback.
 */
const BLOCK_COLLAPSE_PREFERENCE: PreferenceDefinition<string[]> = {
  key: 'collapsed_ids',
  scope: 'page',
  version: 1,
  defaultValue: [] as string[],
  parse: jsonParse<string[]>,
  serialize: jsonSerialize<string[]>,
}

/**
 * Central registry of every localStorage-backed app preference. New keys go
 * here (see module docstring) so preferences stay discoverable in one place.
 */
export const PREFERENCES = {
  density: DENSITY_PREFERENCE,
  sort: SORT_PREFERENCE,
  weekStart: WEEK_START_PREFERENCE,
  journalDateFormat: JOURNAL_DATE_FORMAT_PREFERENCE,
  gestureCoachmarkSeen: GESTURE_COACHMARK_SEEN_PREFERENCE,
  onboardingDone: ONBOARDING_DONE_PREFERENCE,
  spaceOnboardingSeen: SPACE_ONBOARDING_SEEN_PREFERENCE,
  tagColors: TAG_COLORS_PREFERENCE,
  pinnedSearchScope: PINNED_SEARCH_SCOPE_PREFERENCE,
  emojiPickerEnabled: EMOJI_PICKER_ENABLED_PREFERENCE,
  tabIndentsBlocks: TAB_INDENTS_BLOCKS_PREFERENCE,
  starredPages: STARRED_PAGES_PREFERENCE,
  quickCaptureShortcut: QUICK_CAPTURE_SHORTCUT_PREFERENCE,
  sidebarWidth: SIDEBAR_WIDTH_PREFERENCE,
  filterSyntaxIntroToastShown: FILTER_SYNTAX_INTRO_TOAST_SHOWN_PREFERENCE,
  motion: MOTION_PREFERENCE,
  fontSize: FONT_SIZE_PREFERENCE,
  deadlineWarningDays: DEADLINE_WARNING_DAYS_PREFERENCE,
  lastUpdateCheck: LAST_UPDATE_CHECK_PREFERENCE,
  settingsActiveTab: SETTINGS_ACTIVE_TAB_PREFERENCE,
  blockCollapseLegacy: BLOCK_COLLAPSE_LEGACY_PREFERENCE,
  pathHistory: PATH_HISTORY_PREFERENCE,
  recentSearches: RECENT_SEARCHES_PREFERENCE,
  recentCommandsPalette: RECENT_COMMANDS_PALETTE_PREFERENCE,
  recentCommandsSlash: RECENT_COMMANDS_SLASH_PREFERENCE,
  blockCollapse: BLOCK_COLLAPSE_PREFERENCE,
} as const
