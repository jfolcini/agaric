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

import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { logger } from './logger'

export interface PreferenceDefinition<T> {
  /** The localStorage key base. Kept verbatim — never re-keyed. */
  key: string
  /**
   * `'device'` → the effective key is `key` as-is. `'space'` → the effective
   * key is `${key}:${spaceId}` and a `spaceId` must be supplied by callers.
   */
  scope: 'device' | 'space'
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
 * - `device` scope: `def.key` verbatim (`spaceId` is ignored).
 * - `space` scope: `${def.key}:${spaceId}`. If a space-scoped definition is
 *   used without a `spaceId`, we take the safe route — warn and fall back to
 *   the bare `def.key` rather than throwing into a render/click path.
 */
export function effectiveKey<T>(def: PreferenceDefinition<T>, spaceId?: string): string {
  if (def.scope === 'space') {
    if (spaceId === undefined || spaceId === '') {
      logger.warn(
        `preference:${def.key}`,
        'Space-scoped preference used without a spaceId; falling back to bare key',
        { key: def.key },
      )
      return def.key
    }
    return `${def.key}:${spaceId}`
  }
  return def.key
}

/**
 * Read a preference value directly (non-hook). SSR-safe; applies `migrate`
 * before `parse`; falls back to `def.defaultValue` on any failure.
 */
export function readPreference<T>(def: PreferenceDefinition<T>, spaceId?: string): T {
  if (typeof window === 'undefined') return def.defaultValue
  const key = effectiveKey(def, spaceId)
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return def.defaultValue
    try {
      const migrated = def.migrate ? def.migrate(raw) : raw
      // migrate → null means "discard the legacy value".
      if (migrated === null) return def.defaultValue
      return def.parse(migrated)
    } catch {
      // Invalid / undecodable stored data — fall back silently. Expected on
      // the first read after a format change (see module docstring).
      return def.defaultValue
    }
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to read localStorage preference', { key }, err)
    return def.defaultValue
  }
}

/**
 * Write a preference value directly (non-hook). SSR-safe; swallows and warns
 * on any storage failure (quota, private mode, locked-down webview).
 */
export function writePreference<T>(def: PreferenceDefinition<T>, value: T, spaceId?: string): void {
  if (typeof window === 'undefined') return
  const key = effectiveKey(def, spaceId)
  try {
    localStorage.setItem(key, def.serialize(value))
  } catch (err) {
    logger.warn(`preference:${def.key}`, 'Failed to write localStorage preference', { key }, err)
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
  spaceId?: string,
): [T, (value: T | ((prev: T) => T)) => void] {
  const key = effectiveKey(def, spaceId)
  // `useLocalStoragePreference` only invokes `parse` on the initial read
  // (its `useState` initializer), so composing `migrate` here means the
  // legacy → current transform runs exactly on mount. A `null` from
  // `migrate` (discard) is surfaced as a throw so the shared hook's
  // parse-failure path resets to `defaultValue`.
  const parse = (raw: string): T => {
    const migrated = def.migrate ? def.migrate(raw) : raw
    if (migrated === null) throw new Error('preference migrate: discarded legacy value')
    return def.parse(migrated)
  }
  return useLocalStoragePreference<T>(key, def.defaultValue, {
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

/**
 * Central registry of every localStorage-backed app preference. New keys go
 * here (see module docstring) so preferences stay discoverable in one place.
 */
export const PREFERENCES = {
  density: DENSITY_PREFERENCE,
  sort: SORT_PREFERENCE,
} as const
