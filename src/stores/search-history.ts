/**
 * PEND-55 — Search history store.
 *
 * Zustand-persisted, per-space MRU list of submitted search queries.
 * Mirrors the existing `agaric:`-prefixed pattern (see
 * `stores/recent-pages.ts:99`) and partitions by space so a query
 * referencing space-specific paths / tags doesn't surface cross-space.
 *
 * Capped at [`MAX_HISTORY`] entries per space (recommendation locked in
 * by PEND-55's open Q2). Submitting the same query twice moves the
 * existing entry to the front (MRU dedup); duplicate strings never
 * accumulate.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Maximum history entries per space.
 *
 * 20 is the plan-recommended value (Q2). Adjustable post-launch if
 * usage tells us more depth is wanted; raising it is wire-compat-safe
 * because the cap only fires inside the `push` reducer.
 */
export const MAX_HISTORY = 20

/**
 * Sentinel space key for callers that pre-date the per-space split
 * (e.g. unit tests; the storybook fixtures). Mirrors
 * `recent-pages.ts`'s `__legacy__` partition.
 */
export const LEGACY_HISTORY_SPACE_KEY = '__legacy__'

interface SearchHistoryState {
  /** Per-space MRU lists. Keyed by space id (or `__legacy__`). */
  bySpace: Record<string, string[]>
  /**
   * UX-11 — when `false`, `push` is a no-op (recording is paused) and
   * the dropdown shows the disabled notice. Persisted alongside the
   * history so the preference survives reloads.
   */
  historyEnabled: boolean
  /** Push a submitted query onto the active-space MRU list. No-op on empty. */
  push: (spaceId: string | null | undefined, query: string) => void
  /** Clear the MRU list for the given space (does not affect other spaces). */
  clear: (spaceId: string | null | undefined) => void
  /**
   * UX-11 — remove a single query from the given space's MRU list.
   * No-op when the query isn't present. Other spaces untouched.
   */
  removeEntry: (spaceId: string | null | undefined, query: string) => void
  /** UX-11 — toggle whether new submissions are recorded. */
  setHistoryEnabled: (enabled: boolean) => void
}

function spaceKey(spaceId: string | null | undefined): string {
  if (!spaceId) return LEGACY_HISTORY_SPACE_KEY
  return spaceId
}

/**
 * FE-14 — coerce arbitrary persisted JSON into a valid `bySpace` shape.
 *
 * `localStorage` can hold anything (manual edits, a corrupt write, a
 * future-shape downgrade). Hydrating it with a bare `as` cast lets a
 * malformed blob poison the store and crash the reducers / selectors.
 * This drops everything that isn't a string-keyed map of string
 * arrays, and within each array drops non-string / empty / duplicate
 * entries and clamps to `MAX_HISTORY`.
 */
export function coerceBySpace(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (trimmed.length === 0 || seen.has(trimmed)) continue
      seen.add(trimmed)
      cleaned.push(trimmed)
      if (cleaned.length >= MAX_HISTORY) break
    }
    if (cleaned.length > 0) out[key] = cleaned
  }
  return out
}

/**
 * CR-PERSIST (#1609) — coerce an entire persisted search-history blob
 * field-by-field. Shared by `migrate` (version-mismatched blobs) and `merge`
 * (same-version blobs): zustand's persist middleware only calls `migrate`
 * when the stored version DIFFERS from `options.version`, so a corrupt blob
 * that still carries `version: 1` (or a non-numeric version) bypasses
 * `migrate` entirely and reaches the default shallow `merge` raw — coercing
 * in `merge` as well closes that path. The coercion is idempotent, so the
 * migrate→merge double pass on version-mismatched blobs is harmless.
 */
function coercePersistedSearchHistory(
  persisted: unknown,
): Pick<SearchHistoryState, 'bySpace' | 'historyEnabled'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  return {
    bySpace: coerceBySpace(blob['bySpace']),
    historyEnabled: typeof blob['historyEnabled'] === 'boolean' ? blob['historyEnabled'] : true,
  }
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set) => ({
      bySpace: {},
      historyEnabled: true,
      push: (spaceId, query) =>
        set((state) => {
          // UX-11 — recording paused: drop the submission silently.
          if (!state.historyEnabled) return state
          const trimmed = query.trim()
          if (trimmed.length === 0) return state
          const key = spaceKey(spaceId)
          const existing = state.bySpace[key] ?? []
          // Dedupe by exact match (case-sensitive — preserves PEND-54
          // syntax like `tag:#Urgent` vs `tag:#urgent`).
          const filtered = existing.filter((q) => q !== trimmed)
          const next = [trimmed, ...filtered].slice(0, MAX_HISTORY)
          return { bySpace: { ...state.bySpace, [key]: next } }
        }),
      clear: (spaceId) =>
        set((state) => {
          const key = spaceKey(spaceId)
          return { bySpace: { ...state.bySpace, [key]: [] } }
        }),
      removeEntry: (spaceId, query) =>
        set((state) => {
          const key = spaceKey(spaceId)
          const existing = state.bySpace[key]
          if (!existing) return state
          const next = existing.filter((q) => q !== query)
          // No change → keep the same reference so selectors don't fire.
          if (next.length === existing.length) return state
          return { bySpace: { ...state.bySpace, [key]: next } }
        }),
      setHistoryEnabled: (enabled) => set({ historyEnabled: enabled }),
    }),
    {
      name: 'agaric:search-history',
      version: 1,
      partialize: (state) => ({
        bySpace: state.bySpace,
        historyEnabled: state.historyEnabled,
      }),
      // PEND-73 Phase 4.R1 — no-op migrate placeholder. Locks the
      // contract: a future `version: 2` bump MUST replace this with
      // a real migration. Without the placeholder, zustand's persist
      // middleware silently wipes the persisted state on a version
      // mismatch and the user loses their MRU history.
      //
      // FE-14 — validate/coerce the persisted blob on read so a corrupt
      // `localStorage` payload can't poison the store.
      //
      // CR-PERSIST (#1609): zustand only invokes `migrate` on a version
      // MISMATCH — it is NOT run for every load. A corrupt blob still
      // tagged `version: 1` bypasses `migrate` and reaches `merge` raw, so
      // the field-by-field coercion is shared with `merge` below.
      migrate: (persisted, _version) => coercePersistedSearchHistory(persisted),
      // CR-PERSIST (#1609) — zustand skips `migrate` when the stored
      // version equals `options.version` (or isn't a number), handing the
      // raw blob straight to `merge`. Coerce here too so a corrupt
      // `localStorage` payload that still says `version: 1` (e.g. a
      // malformed `bySpace`, a non-boolean `historyEnabled`) can't poison
      // the store on rehydrate.
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedSearchHistory(persisted),
      }),
    },
  ),
)

/**
 * Selector — returns the MRU list for a given space without
 * triggering re-renders on writes that target a different space.
 * Stable when the underlying array reference is unchanged.
 */
export function selectHistoryForSpace(
  state: SearchHistoryState,
  spaceId: string | null | undefined,
): ReadonlyArray<string> {
  return state.bySpace[spaceKey(spaceId)] ?? EMPTY_HISTORY
}

// Shared empty-array sentinel — same reference across calls so
// useStore selectors don't fire on every render.
const EMPTY_HISTORY: ReadonlyArray<string> = Object.freeze([])
