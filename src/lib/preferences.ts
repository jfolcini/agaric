/**
 * Typed localStorage preferences registry (#2466).
 *
 * ## Why
 *
 * `localStorage` was a de-facto second persistence tier with none of the
 * discipline the SQL tier has: some keys `agaric:`-namespaced, some bare;
 * only one (`savedViews`, not yet shipped) planned a version suffix;
 * corrupt/missing values handled ad hoc and inconsistently at each call
 * site. This module is the single place a NEW device-local preference is
 * declared — name, type, default, version, and (de)serialization — plus
 * typed `getPref`/`setPref` accessors that never throw.
 *
 * ## Contract
 *
 * - **Device scope, never synced.** Every entry here is `scope: 'device'`.
 *   These preferences deliberately do NOT travel with a space between
 *   devices — see `docs/architecture/frontend.md` § "Preferences registry
 *   (device scope, not synced)". A preference that should follow the user's
 *   *data* (not their device) belongs in a block property or a backend
 *   table, not here.
 * - **Naming.** New keys should be `agaric:`-namespaced
 *   (`agaric:<feature>[:vN]`). Bare legacy keys (`theme-preference`,
 *   `tag-colors`, …) are grandfathered — do not rename an existing key
 *   without a migration, since renaming silently discards every existing
 *   user's stored value (see "Renaming" below).
 * - **Versioning.** `version` is informational today (no entry has shipped
 *   a breaking shape change yet) but is where a future migration hook
 *   attaches: bump it and branch inside `parse` on the old shape when a
 *   preference's persisted format changes incompatibly.
 * - **Corrupt/missing → default, never throw.** `getPref`/`setPref` wrap
 *   every `localStorage` call; a read error, a `parse` throw (corrupt
 *   JSON, an enum value outside the allowlist, …), or a write error
 *   (quota, private-mode, disabled storage) all degrade to the
 *   preference's `defaultValue` rather than propagating.
 * - **Multi-window coherence.** This module does not itself broadcast
 *   changes across windows — `localStorage` already fires a native
 *   `storage` event in every OTHER window on a real write. A caller that
 *   needs same-tab reactivity (the tab that made the write) is
 *   responsible for its own `useSyncExternalStore` + synthetic
 *   `StorageEvent` dispatch, same as before this registry existed (see
 *   `useTheme`, `useWeekStart`, `useJournalDateFormat`,
 *   `useExternalImagePolicy` — deliberately NOT migrated to this registry;
 *   see "What's not migrated" below).
 *
 * ## What's migrated vs. cataloged
 *
 * Per the issue's suggested scope, migration is OPPORTUNISTIC: existing
 * call sites move to `getPref`/`setPref` where doing so is mechanical and
 * behavior-preserving; every migrated key keeps its EXACT existing storage
 * key and wire format, so existing users' stored values keep working
 * un-migrated. `PREF_CATALOG` below documents every known device-local
 * preference key in the app — migrated (backed by a `PrefDef`/`PrefFamily`
 * in `PREFS`, actually read/written through this module) and cataloged
 * (still owned by its original module, listed here so the naming/version/
 * scope contract is documented and so a future migration has a home to
 * land in). New preferences MUST go through `PREFS` from day one.
 *
 * Deliberately NOT migrated in this pass (tracked for a follow-up, not
 * because they don't belong here):
 *   - Hooks that pair a `useSyncExternalStore` snapshot with a SYNTHETIC
 *     same-tab `StorageEvent` dispatch carrying the exact raw old/new
 *     string (`useTheme`, `useWeekStart`, `useJournalDateFormat`,
 *     `useExternalImagePolicy`). `getPref`/`setPref` only expose the
 *     typed value, not the raw string the dispatch needs — migrating
 *     these needs a small API extension (a raw-string variant) plus
 *     dedicated test coverage for the dispatch contract, which is out of
 *     scope for a mechanical migration.
 *   - `src/lib/keyboard-config/storage.ts` — a module-level parsed-value
 *     cache keyed on the raw string, invalidated by both same-module
 *     writes and a `storage` listener. The caching behavior itself (not
 *     just the get/set) is the point of that module.
 *   - `src/hooks/useEmojiRecents.ts` — `readFrequency()`'s legacy-MRU
 *     migration fallback depends on distinguishing "key absent" from "key
 *     present but empty", which `getPref`'s default-collapsing would
 *     erase.
 *   - Zustand-`persist`-backed stores (`stores/journal.ts`, `stores/tabs.ts`,
 *     `stores/navigation.ts`, `stores/search-history.ts`,
 *     `stores/recent-pages.ts`, `stores/pageBrowserFilters.ts`,
 *     `stores/useDebugStore.ts`). These are explicitly OUT OF SCOPE: they
 *     already have their own versioned envelope and migrate function via
 *     zustand's `persist` middleware — the disciplined tier the issue
 *     contrasts against the ad-hoc one. Folding them into this registry
 *     would just add a second competing contract for the same keys.
 *   - Dev/test-only fixture toggles (`src/lib/tauri-mock/seed.ts`'s
 *     `__mockFacetFixture` / `__mockExtraPages`) — not user preferences.
 */

import { logger } from './logger'

/** Every preference here is device-local and never synced across devices. */
export type PrefScope = 'device'

/** A single, statically-keyed preference definition. */
export interface PrefDef<T> {
  /** Stable storage key. Do not rename without a migration (see file header). */
  readonly key: string
  /** Informational today; bump + branch in `parse` on a breaking shape change. */
  readonly version: number
  readonly scope: PrefScope
  /** Returned when the key is absent, unreadable, or fails to parse. */
  readonly defaultValue: T
  /** Parse the raw stored string into `T`. Throwing is treated as "corrupt". */
  parse(raw: string): T
  /** Serialize `T` back to a string for storage. */
  serialize(value: T): string
  /** `logger.warn` source label. Defaults to the pref's `key`. */
  readonly source?: string
}

/**
 * A family of preferences sharing one shape but keyed by a runtime
 * argument (per-space, per-page, per-namespace, …) — e.g. path history is
 * one entry per space, block collapse state is one entry per page.
 * `preferences.ts` intentionally does not know about spaces/pages itself
 * (no import of `active-space.ts` or page state here, to keep this module
 * a leaf); callers resolve the key part(s) and pass them in.
 */
export interface PrefFamily<T, Args extends readonly unknown[]> {
  keyFor(...args: Args): string
  readonly version: number
  readonly scope: PrefScope
  readonly defaultValue: T
  parse(raw: string): T
  serialize(value: T): string
  readonly source?: string
}

function readRaw(key: string, source: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (err) {
    logger.warn(source, 'Failed to read localStorage preference', { key }, err)
    return null
  }
}

function writeRaw(key: string, raw: string, source: string): void {
  try {
    localStorage.setItem(key, raw)
  } catch (err) {
    logger.warn(source, 'Failed to write localStorage preference', { key }, err)
  }
}

function removeRaw(key: string, source: string): void {
  try {
    localStorage.removeItem(key)
  } catch (err) {
    logger.warn(source, 'Failed to remove localStorage preference', { key }, err)
  }
}

/**
 * Shallow-clone a default value before handing it back to a caller.
 *
 * `def.defaultValue` is a single object/array literal stored once on the
 * `PrefDef`/`PrefFamily`. Several migrated call sites mutate the value
 * `getPref`/`getKeyedPref` return in place (e.g. `pages.push(id)`) before
 * calling `setPref` — exactly like the pre-registry code, which always
 * parsed a fresh array/object out of `JSON.parse` on every call and so
 * never shared a reference across calls. Returning `defaultValue` by
 * reference would let that in-place mutation corrupt the shared default
 * for every future "key absent" read; a shallow clone keeps the
 * "always a fresh value" contract for the default branch too. Shallow is
 * sufficient — every default in this module is a flat array or a flat
 * string-keyed record.
 */
function cloneDefault<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (value !== null && typeof value === 'object') return { ...(value as object) } as T
  return value
}

/**
 * Read a preference. Never throws:
 *  - missing key → `defaultValue`
 *  - `localStorage.getItem` throws (private mode, disabled storage) →
 *    `defaultValue`, logged
 *  - `def.parse` throws (corrupt JSON, value outside an enum allowlist) →
 *    `defaultValue`, NOT logged (a stale/corrupt value after a format
 *    change is common and not actionable — mirrors
 *    `useLocalStoragePreference`'s documented failure-mode split)
 */
export function getPref<T>(def: PrefDef<T>): T {
  const raw = readRaw(def.key, def.source ?? def.key)
  if (raw === null) return cloneDefault(def.defaultValue)
  try {
    return def.parse(raw)
  } catch {
    return cloneDefault(def.defaultValue)
  }
}

/** Write a preference. Never throws — a quota/unavailable error is logged and swallowed. */
export function setPref<T>(def: PrefDef<T>, value: T): void {
  writeRaw(def.key, def.serialize(value), def.source ?? def.key)
}

/** Remove a preference's stored value. Never throws. */
export function removePref<T>(def: PrefDef<T>): void {
  removeRaw(def.key, def.source ?? def.key)
}

/**
 * True when the key has ANY stored value (including one that fails to
 * `parse`). Distinct from `getPref(def) !== def.defaultValue` — a caller
 * that needs to tell "never stored" apart from "stored, and happens to
 * equal the default" (e.g. an explicitly-persisted empty array) should use
 * this instead of comparing against `defaultValue`. Never throws.
 */
export function hasPref<T>(def: PrefDef<T>): boolean {
  return readRaw(def.key, def.source ?? def.key) !== null
}

/** Read a keyed preference — see `PrefFamily`. Same failure-mode contract as `getPref`. */
export function getKeyedPref<T, Args extends readonly unknown[]>(
  family: PrefFamily<T, Args>,
  ...args: Args
): T {
  const key = family.keyFor(...args)
  const raw = readRaw(key, family.source ?? key)
  if (raw === null) return cloneDefault(family.defaultValue)
  try {
    return family.parse(raw)
  } catch {
    return cloneDefault(family.defaultValue)
  }
}

/** Write a keyed preference — see `PrefFamily`. Same failure-mode contract as `setPref`. */
export function setKeyedPref<T, Args extends readonly unknown[]>(
  family: PrefFamily<T, Args>,
  value: T,
  ...args: Args
): void {
  const key = family.keyFor(...args)
  writeRaw(key, family.serialize(value), family.source ?? key)
}

/** Remove a keyed preference's stored value. Never throws. */
export function removeKeyedPref<T, Args extends readonly unknown[]>(
  family: PrefFamily<T, Args>,
  ...args: Args
): void {
  const key = family.keyFor(...args)
  removeRaw(key, family.source ?? key)
}

/** Keyed-family form of `hasPref`. Never throws. */
export function hasKeyedPref<T, Args extends readonly unknown[]>(
  family: PrefFamily<T, Args>,
  ...args: Args
): boolean {
  const key = family.keyFor(...args)
  return readRaw(key, family.source ?? key) !== null
}

// ─── JSON helpers for defining PrefDef/PrefFamily entries ───────────

const jsonParse = <T>(raw: string): T => JSON.parse(raw) as T
const jsonSerialize = <T>(value: T): string => JSON.stringify(value)

// ─── Migrated preferences ────────────────────────────────
//
// Actually read/written through `getPref`/`setPref`/`getKeyedPref`/
// `setKeyedPref` by their owning module. Every `key` string below is
// copied VERBATIM from the pre-registry call site — existing users' stored
// values keep working unchanged.

export const PREFS = {
  /** `src/lib/gesture-coachmark.ts` — first-run mobile gesture coach-mark dismissed. */
  gestureCoachmarkSeen: {
    key: 'agaric-gesture-coachmark-seen',
    version: 1,
    scope: 'device',
    defaultValue: false,
    // Legacy format: presence of ANY value means "seen" (always written as
    // the literal string 'true', but the original reader was `!!raw`).
    parse: () => true,
    serialize: () => 'true',
  } satisfies PrefDef<boolean>,

  /** `src/lib/onboarding.ts` — first-run welcome modal dismissed. */
  onboardingDone: {
    key: 'agaric-onboarding-done',
    version: 1,
    scope: 'device',
    defaultValue: false,
    parse: () => true,
    serialize: () => 'true',
  } satisfies PrefDef<boolean>,

  /** `src/components/SpaceManageDialog/SpaceOnboardingHint.tsx` — manage-spaces dialog onboarding banner dismissed. Do NOT rename — see that file's header. */
  spaceOnboardingSeen: {
    key: 'agaric:space-onboarding-seen-v1',
    version: 1,
    scope: 'device',
    defaultValue: false,
    // Exact-match 'true' (not mere presence) — mirrors the original reader.
    parse: (raw) => raw === 'true',
    serialize: () => 'true',
  } satisfies PrefDef<boolean>,

  /** `src/lib/tag-colors.ts` — tag id -> CSS color/accent-token map. */
  tagColors: {
    key: 'tag-colors',
    version: 1,
    scope: 'device',
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
  } satisfies PrefDef<Record<string, string>>,

  /** `src/lib/pinned-search-scope.ts` — pinned default segment for the mobile search sheet. */
  pinnedSearchScope: {
    key: 'pinned_search_scope',
    version: 1,
    scope: 'device',
    defaultValue: null as 'in-page' | 'all-pages' | null,
    parse: (raw) => {
      if (raw === 'in-page' || raw === 'all-pages') return raw
      throw new Error(`invalid pinned search scope: ${raw}`)
    },
    serialize: (value) => value ?? '',
  } satisfies PrefDef<'in-page' | 'all-pages' | null>,

  /** `src/lib/editor-preferences.ts` — inline `:` emoji picker enabled. Default true (absent/corrupt -> on). */
  emojiPickerEnabled: {
    key: 'agaric-emoji-picker-enabled',
    version: 1,
    scope: 'device',
    defaultValue: true,
    // Legacy semantics: anything other than a JSON-encoded `false` counts as enabled.
    parse: (raw) => (JSON.parse(raw) as unknown) !== false,
    serialize: jsonSerialize<boolean>,
  } satisfies PrefDef<boolean>,

  /** `src/lib/editor-preferences.ts` — Tab/Shift+Tab indents blocks. Default true. */
  tabIndentsBlocks: {
    key: 'agaric-tab-indents-blocks',
    version: 1,
    scope: 'device',
    defaultValue: true,
    parse: (raw) => (JSON.parse(raw) as unknown) !== false,
    serialize: jsonSerialize<boolean>,
  } satisfies PrefDef<boolean>,

  /** `src/lib/starred-pages.ts` — starred (favorited) page ids. */
  starredPages: {
    key: 'starred-pages',
    version: 1,
    scope: 'device',
    defaultValue: [] as string[],
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === 'string')
    },
    serialize: jsonSerialize<string[]>,
  } satisfies PrefDef<string[]>,

  /** `src/lib/quick-capture-shortcut.ts` — user-configured global-shortcut accelerator. Empty string sentinel = "not set". */
  quickCaptureShortcut: {
    key: 'agaric:quickCaptureShortcut',
    version: 1,
    scope: 'device',
    defaultValue: '',
    parse: (raw) => raw,
    serialize: (value) => value,
  } satisfies PrefDef<string>,

  /** `src/components/ui/sidebar/use-sidebar-state.ts` — sidebar drag-resize width in px. `-1` sentinel = "not stored" (distinct from a genuine below-minimum value). */
  sidebarWidth: {
    key: 'sidebar_width',
    version: 1,
    scope: 'device',
    defaultValue: -1,
    parse: (raw) => {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error('not a number')
      return n
    },
    serialize: (value) => String(value),
  } satisfies PrefDef<number>,

  /** `src/components/SearchPanel/useFilterSyntaxIntroToast.ts` — one-time "filter syntax is live" toast shown. */
  filterSyntaxIntroToastShown: {
    key: 'agaric:searchFilterSyntaxToast:v1',
    version: 1,
    scope: 'device',
    defaultValue: false,
    parse: () => true,
    serialize: () => '1',
  } satisfies PrefDef<boolean>,

  /** `src/components/settings/AppearanceTab.tsx` — editor/UI font size. */
  fontSize: {
    key: 'agaric-font-size',
    version: 1,
    scope: 'device',
    defaultValue: 'medium' as 'small' | 'medium' | 'large',
    parse: (raw) => {
      if (raw === 'small' || raw === 'medium' || raw === 'large') return raw
      throw new Error(`invalid font size: ${raw}`)
    },
    serialize: (value) => value,
  } satisfies PrefDef<'small' | 'medium' | 'large'>,

  /** `src/hooks/useDuePanelData.ts` + `src/components/agenda/DeadlineWarningSection.tsx` — overdue-warning lead time in days. Legacy on-disk format is a bare integer (not JSON). */
  deadlineWarningDays: {
    key: 'agaric:deadlineWarningDays',
    version: 1,
    scope: 'device',
    defaultValue: 0,
    parse: (raw) => {
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n)) throw new Error('not a number')
      return n
    },
    serialize: (value) => String(value),
  } satisfies PrefDef<number>,

  /** `src/hooks/useUpdateCheck.ts` — ISO timestamp of the last successful update check. `null` = never checked. */
  lastUpdateCheck: {
    key: 'agaric:last-update-check',
    version: 1,
    scope: 'device',
    defaultValue: null as string | null,
    parse: (raw) => raw,
    serialize: (value) => value ?? '',
  } satisfies PrefDef<string | null>,

  /** `src/lib/url-state.ts` — Settings panel's active tab. Validated against `SettingsTab` by `SettingsView` (this module deliberately stays feature-agnostic). Empty string sentinel = "not stored". */
  settingsActiveTab: {
    key: 'agaric-settings-active-tab',
    version: 1,
    scope: 'device',
    defaultValue: '',
    parse: (raw) => raw,
    serialize: (value) => value,
  } satisfies PrefDef<string>,

  /** `src/hooks/useBlockCollapse.ts` — pre-#752 GLOBAL collapsed-block-id list. Read-only migration fallback; never written again. */
  blockCollapseLegacy: {
    key: 'collapsed_ids',
    version: 1,
    scope: 'device',
    defaultValue: [] as string[],
    parse: jsonParse<string[]>,
    serialize: jsonSerialize<string[]>,
  } satisfies PrefDef<string[]>,

  /** `src/lib/path-history.ts` — per-space MRU of `path:`/`not-path:` globs, keyed by space id. */
  pathHistory: {
    keyFor: (spaceId: string) => `agaric:pathHistory:v1:${spaceId}`,
    version: 1,
    scope: 'device',
    defaultValue: [] as string[],
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === 'string')
    },
    serialize: jsonSerialize<string[]>,
  } satisfies PrefFamily<string[], [spaceId: string]>,

  /** `src/lib/recent-searches.ts` — per-space MRU of recent search terms, keyed by space id. */
  recentSearches: {
    keyFor: (spaceId: string) => `recent_searches:${spaceId}`,
    version: 1,
    scope: 'device',
    defaultValue: [] as string[],
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    },
    serialize: jsonSerialize<string[]>,
  } satisfies PrefFamily<string[], [spaceId: string]>,

  /** `src/lib/recent-commands.ts` — per-(namespace, space) MRU of recently-run command ids. `prefix` is `recent_commands` (palette) or `RECENT_SLASH_PREFIX` (slash menu). */
  recentCommands: {
    keyFor: (prefix: string, spaceId: string) => `${prefix}:${spaceId}`,
    version: 1,
    scope: 'device',
    defaultValue: [] as { id: string; runAt: string }[],
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is { id: string; runAt: string } =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>)['id'] === 'string' &&
          typeof (item as Record<string, unknown>)['runAt'] === 'string',
      )
    },
    serialize: jsonSerialize<{ id: string; runAt: string }[]>,
  } satisfies PrefFamily<{ id: string; runAt: string }[], [prefix: string, spaceId: string]>,

  /** `src/hooks/useBlockCollapse.ts` — collapsed block ids, keyed by page root id (#752). */
  blockCollapse: {
    keyFor: (pageKey: string) => `collapsed_ids:${pageKey}`,
    version: 1,
    scope: 'device',
    defaultValue: [] as string[],
    parse: jsonParse<string[]>,
    serialize: jsonSerialize<string[]>,
  } satisfies PrefFamily<string[], [pageKey: string]>,
} as const

// ─── Full key catalog (migrated + cataloged) ───────────────────
//
// Documents EVERY known device-local preference key so naming/version/
// scope is recorded centrally even for keys not yet migrated to
// `getPref`/`setPref` (see file header, "What's migrated vs. cataloged").
// `status: 'migrated'` entries are backed by a `PREFS` entry above;
// `status: 'cataloged'` entries are still read/written directly by their
// owning module and are grandfathered in `scripts/check-raw-local-storage.mjs`.

export interface PrefCatalogEntry {
  readonly key: string
  /** Human-readable type, e.g. `'boolean'`, `'string[]'`, `"'a' | 'b'"`. */
  readonly type: string
  readonly version: number
  readonly scope: PrefScope
  /** File that owns the read/write (the `PREFS` entry, or the raw call sites). */
  readonly owner: string
  readonly status: 'migrated' | 'cataloged'
  readonly notes?: string
}

export const PREF_CATALOG: readonly PrefCatalogEntry[] = [
  {
    key: PREFS.gestureCoachmarkSeen.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/lib/gesture-coachmark.ts',
    status: 'migrated',
  },
  {
    key: PREFS.onboardingDone.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/lib/onboarding.ts',
    status: 'migrated',
  },
  {
    key: PREFS.spaceOnboardingSeen.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/components/SpaceManageDialog/SpaceOnboardingHint.tsx',
    status: 'migrated',
  },
  {
    key: PREFS.tagColors.key,
    type: 'Record<string, string>',
    version: 1,
    scope: 'device',
    owner: 'src/lib/tag-colors.ts',
    status: 'migrated',
  },
  {
    key: PREFS.pinnedSearchScope.key,
    type: "'in-page' | 'all-pages' | null",
    version: 1,
    scope: 'device',
    owner: 'src/lib/pinned-search-scope.ts',
    status: 'migrated',
  },
  {
    key: PREFS.emojiPickerEnabled.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/lib/editor-preferences.ts',
    status: 'migrated',
  },
  {
    key: PREFS.tabIndentsBlocks.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/lib/editor-preferences.ts',
    status: 'migrated',
  },
  {
    key: PREFS.starredPages.key,
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/lib/starred-pages.ts',
    status: 'migrated',
  },
  {
    key: PREFS.quickCaptureShortcut.key,
    type: 'string',
    version: 1,
    scope: 'device',
    owner: 'src/lib/quick-capture-shortcut.ts',
    status: 'migrated',
  },
  {
    key: PREFS.sidebarWidth.key,
    type: 'number',
    version: 1,
    scope: 'device',
    owner: 'src/components/ui/sidebar/use-sidebar-state.ts',
    status: 'migrated',
  },
  {
    key: PREFS.filterSyntaxIntroToastShown.key,
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/components/SearchPanel/useFilterSyntaxIntroToast.ts',
    status: 'migrated',
  },
  {
    key: PREFS.fontSize.key,
    type: "'small' | 'medium' | 'large'",
    version: 1,
    scope: 'device',
    owner: 'src/components/settings/AppearanceTab.tsx',
    status: 'migrated',
  },
  {
    key: PREFS.deadlineWarningDays.key,
    type: 'number',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useDuePanelData.ts, src/components/agenda/DeadlineWarningSection.tsx',
    status: 'migrated',
  },
  {
    key: PREFS.lastUpdateCheck.key,
    type: 'string | null',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useUpdateCheck.ts',
    status: 'migrated',
  },
  {
    key: PREFS.settingsActiveTab.key,
    type: 'string',
    version: 1,
    scope: 'device',
    owner: 'src/lib/url-state.ts',
    status: 'migrated',
  },
  {
    key: PREFS.blockCollapseLegacy.key,
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useBlockCollapse.ts',
    status: 'migrated',
    notes: 'Legacy pre-#752 global key. Read-only migration fallback.',
  },
  {
    key: 'agaric:pathHistory:v1:<spaceId>',
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/lib/path-history.ts',
    status: 'migrated',
    notes: 'Keyed family (PREFS.pathHistory) — one entry per space.',
  },
  {
    key: 'recent_searches:<spaceId>',
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/lib/recent-searches.ts',
    status: 'migrated',
    notes: 'Keyed family (PREFS.recentSearches) — one entry per space.',
  },
  {
    key: '<recent_commands|recent_slash>:<spaceId>',
    type: '{ id: string; runAt: string }[]',
    version: 1,
    scope: 'device',
    owner: 'src/lib/recent-commands.ts',
    status: 'migrated',
    notes: 'Keyed family (PREFS.recentCommands) — one entry per (namespace, space).',
  },
  {
    key: 'collapsed_ids:<pageKey>',
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useBlockCollapse.ts',
    status: 'migrated',
    notes: 'Keyed family (PREFS.blockCollapse) — one entry per page.',
  },
  // ── Cataloged (not yet migrated — see file header) ────────────────
  {
    key: 'theme-preference',
    type: 'ThemePreference',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useTheme.ts',
    status: 'cataloged',
    notes: 'useSyncExternalStore + synthetic StorageEvent dispatch — see file header.',
  },
  {
    key: 'week-start-preference',
    type: '0 | 1',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useWeekStart.ts',
    status: 'cataloged',
    notes: 'useSyncExternalStore + synthetic StorageEvent dispatch — see file header.',
  },
  {
    key: 'journal-date-format',
    type: 'JournalDateFormat',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useJournalDateFormat.ts',
    status: 'cataloged',
    notes: 'useSyncExternalStore + synthetic StorageEvent dispatch — see file header.',
  },
  {
    key: 'external-image-policy',
    type: "'always' | 'click' | 'never'",
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useExternalImagePolicy.ts',
    status: 'cataloged',
    notes: 'useSyncExternalStore + synthetic StorageEvent dispatch — see file header.',
  },
  {
    key: 'external-image-allowlist',
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useExternalImagePolicy.ts',
    status: 'cataloged',
    notes: 'useSyncExternalStore + synthetic StorageEvent dispatch — see file header.',
  },
  {
    key: 'agaric-keyboard-shortcuts',
    type: 'Record<string, string>',
    version: 1,
    scope: 'device',
    owner: 'src/lib/keyboard-config/storage.ts',
    status: 'cataloged',
    notes: 'Module-level parse cache keyed on the raw string — see file header.',
  },
  {
    key: 'emoji_recents',
    type: 'string[]',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useEmojiRecents.ts',
    status: 'cataloged',
    notes: 'Legacy MRU array; one-time migration source for emoji_frequency.',
  },
  {
    key: 'emoji_frequency',
    type: 'Record<string, { n: number; t: number }>',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useEmojiRecents.ts',
    status: 'cataloged',
    notes: 'Absent-vs-empty distinction feeds the legacy migration — see file header.',
  },
  {
    key: 'agaric:graph-filters',
    type: 'FilterPredicate[] (canonical)',
    version: 1,
    scope: 'device',
    owner: 'src/components/graph/GraphFilterBar.tsx',
    status: 'cataloged',
  },
  {
    key: 'agaric:searchToggles:v1',
    type: 'SearchToggleState',
    version: 1,
    scope: 'device',
    owner: 'src/components/SearchPanel.tsx',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'agaric:agenda:groupBy',
    type: 'AgendaGroupBy',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useAgendaPreferences.ts',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'agaric:agenda:sortBy',
    type: 'AgendaSortBy',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/useAgendaPreferences.ts',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'page-browser-density',
    type: 'DensityMode',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/usePageBrowserDensity.ts',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'page-browser-sort',
    type: 'SortOption',
    version: 1,
    scope: 'device',
    owner: 'src/hooks/usePageBrowserSort.ts',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'agaric-notifications-enabled',
    type: 'boolean',
    version: 1,
    scope: 'device',
    owner: 'src/components/settings/NotificationsTab.tsx',
    status: 'cataloged',
    notes: 'Already routed through the typed useLocalStoragePreference hook.',
  },
  {
    key: 'unfinishedTasks.collapsed',
    type: 'boolean (legacy)',
    version: 1,
    scope: 'device',
    owner: 'src/components/journal/UnfinishedTasks.tsx',
    status: 'cataloged',
    notes: 'One-time legacy default resolver for a useLocalStoragePreference-backed key.',
  },
] as const

/**
 * Planned, not yet shipped: `agaric:pages:savedViews:v1` (#81,
 * `docs/architecture/pages-view.md`). When that feature lands, its key
 * MUST be declared in `PREFS`/`PREF_CATALOG` from the first commit — this
 * registry existing is the whole point of naming the key `:v1` up front.
 */
