/**
 * Page-browser compound-filter store.
 *
 * The Pages view's compound filter chips used to live in `PageBrowser`'s local
 * `useState`. Creating a page opens the editor, which unmounts the Pages view
 * (`ViewDispatcher` is a `switch` over `currentView`), so navigating back reset
 * the chips to empty — and switching space while the view stayed mounted leaked
 * one space's chips onto another. This in-memory, per-space store lifts the
 * chips out of component state so they:
 *
 * - survive the navigation round-trip within a session (create → editor → back),
 * - stay partitioned by space (chip values reference space-scoped ids — tags,
 *   pages — so a space switch reads the new space's slice, the default if none, and
 *   chips never cross spaces),
 * - survive an app restart (#1750): persisted to localStorage so the same
 *   "I set up a filter" gesture has the same lifetime as the graph view's
 *   filters (which already persist via `GraphFilterBar`'s `agaric:graph-filters`
 *   key). Backlinks deliberately stay page-scoped and reset on navigation; the
 *   two surfaces that own a durable filter set (graph + pages) now persist
 *   consistently.
 *
 * A space with no stored slice reads as `DEFAULT_PAGE_FILTERS` (#5370); a
 * stored `[]` is the user having removed it, so it stays empty.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { FilterPrimitive } from '@/lib/bindings'
import { JOURNAL_PAGE_GLOB } from '@/lib/date-utils'
import type { PageFilterWithKey } from '@/lib/filters/page-filter-with-key'
import { safePersistStorage } from '@/lib/safe-persist-storage'
import { LEGACY_SPACE_KEY } from '@/stores/space'

interface PageBrowserFiltersState {
  /** Per-space active chip lists, keyed by space id (`__legacy__` for no-space). */
  filtersBySpace: Record<string, PageFilterWithKey[]>
  /**
   * Monotonic counter for the React-key-only `_addId`. Lives in the store (was a
   * `useRef` in `PageBrowser`) so chip keys stay unique across re-mounts.
   */
  nextAddId: number
  /** Append a chip to the space's list, de-duping structurally-identical chips. */
  addFilter: (spaceKey: string, filter: FilterPrimitive) => void
  /** Remove the chip at `index` from the space's list. */
  removeFilter: (spaceKey: string, index: number) => void
  /** Clear every chip for the space (no-op when already empty). */
  clearFilters: (spaceKey: string) => void
}

export const EXCLUDE_JOURNAL_PAGES_FILTER = {
  type: 'PathGlob',
  pattern: JOURNAL_PAGE_GLOB,
  exclude: true,
} as const satisfies FilterPrimitive

export function isExcludeJournalPagesFilter(filter: FilterPrimitive): boolean {
  return filter.type === 'PathGlob' && filter.exclude && filter.pattern === JOURNAL_PAGE_GLOB
}

/**
 * Stable frozen fallback for an absent slice. Returning a fresh array from the
 * selector each call would retrigger every consumer via `Object.is`, so the
 * reference must stay stable (mirrors `recent-pages`' `EMPTY_PAGE_REFS`).
 * `_addId` 0 is never minted: `addFilter` pre-increments from 0.
 */
const DEFAULT_PAGE_FILTERS: readonly PageFilterWithKey[] = Object.freeze([
  { ...EXCLUDE_JOURNAL_PAGES_FILTER, _addId: 0 },
])

/**
 * Light structural check — a full `FilterPrimitive` discriminant match isn't
 * worth duplicating here (mirrors `isFilterPrimitiveLike` in `lib/preferences.ts`).
 */
function isPageFilterWithKeyLike(value: unknown): value is PageFilterWithKey {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['type'] === 'string' && typeof v['_addId'] === 'number'
}

/**
 * Coerce an arbitrary persisted value into a valid `filtersBySpace` shape,
 * dropping non-array slices and any entry that doesn't look like a
 * `PageFilterWithKey` (mirrors `coerceBySpace` in `stores/search-history.ts`).
 * An empty slice is kept: dropping it would bring the default back.
 */
function coerceFiltersBySpace(raw: unknown): Record<string, PageFilterWithKey[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PageFilterWithKey[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = value.filter(isPageFilterWithKeyLike)
  }
  return out
}

/** Coerce an arbitrary persisted `nextAddId` into a non-negative integer, defaulting to 0. */
function coerceNextAddId(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

/**
 * CR-PERSIST — coerce an entire persisted page-browser-filters blob
 * field-by-field. Shared by `migrate` (version-mismatched blobs) and `merge`
 * (same-version blobs): zustand's persist middleware only calls `migrate`
 * when the stored version DIFFERS from `options.version`, so a corrupt blob
 * that still carries `version: 1` (or a non-numeric version) bypasses
 * `migrate` entirely and reaches the default shallow `merge` raw — coercing
 * in `merge` as well closes that path (mirrors `search-history.ts`). The
 * coercion is idempotent, so the migrate→merge double pass on
 * version-mismatched blobs is harmless.
 */
function coercePersistedPageBrowserFilters(
  persisted: unknown,
): Pick<PageBrowserFiltersState, 'filtersBySpace' | 'nextAddId'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  return {
    filtersBySpace: coerceFiltersBySpace(blob['filtersBySpace']),
    nextAddId: coerceNextAddId(blob['nextAddId']),
  }
}

function filtersForKey(state: PageBrowserFiltersState, spaceKey: string): PageFilterWithKey[] {
  return state.filtersBySpace[spaceKey] ?? (DEFAULT_PAGE_FILTERS as PageFilterWithKey[])
}

/**
 * Per-space chip selector. Pass `currentSpaceId` from `useSpaceStore`; `null`
 * (pre-bootstrap) maps to the `__legacy__` slot. Returns the stable frozen
 * default for an absent slice so the selector is referentially idempotent.
 */
export function selectPageFiltersForSpace(
  state: PageBrowserFiltersState,
  spaceId: string | null,
): PageFilterWithKey[] {
  return filtersForKey(state, spaceId ?? LEGACY_SPACE_KEY)
}

export const usePageBrowserFiltersStore = create<PageBrowserFiltersState>()(
  persist(
    (set) => ({
      filtersBySpace: {},
      nextAddId: 0,
      addFilter: (spaceKey, filter) =>
        set((state) => {
          const current = filtersForKey(state, spaceKey)
          // Dedupe: strip the React-key-only `_addId` and compare a stable JSON
          // serialisation. Re-applying a structurally-identical chip is a no-op —
          // it would ship a duplicate primitive to the IPC (an AND of a condition
          // with itself) and add a redundant pill.
          const incoming = JSON.stringify(filter)
          if (current.some(({ _addId, ...rest }) => JSON.stringify(rest) === incoming)) {
            return state
          }
          const nextAddId = state.nextAddId + 1
          return {
            nextAddId,
            filtersBySpace: {
              ...state.filtersBySpace,
              [spaceKey]: [...current, { ...filter, _addId: nextAddId }],
            },
          }
        }),
      removeFilter: (spaceKey, index) =>
        set((state) => {
          const current = filtersForKey(state, spaceKey)
          return {
            filtersBySpace: {
              ...state.filtersBySpace,
              [spaceKey]: current.filter((_, i) => i !== index),
            },
          }
        }),
      clearFilters: (spaceKey) =>
        set((state) => {
          const current = filtersForKey(state, spaceKey)
          if (current.length === 0) return state
          return {
            filtersBySpace: { ...state.filtersBySpace, [spaceKey]: [] },
          }
        }),
    }),
    {
      name: 'agaric:page-browser-filters',
      version: 1,
      storage: safePersistStorage,
      // Persist the chip lists and the monotonic id counter so `_addId` keys
      // stay unique across a restart (a fresh 0 would collide with rehydrated
      // chips). Function members are not serialisable and are excluded.
      partialize: (state) => ({
        filtersBySpace: state.filtersBySpace,
        nextAddId: state.nextAddId,
      }),
      // #3323 — harden the read path: an unrecognized/corrupt blob (bad
      // manual edit, future-shape downgrade) must not throw the PageBrowser
      // via `.map`/`.length` on a non-array slice, or wedge `nextAddId` into
      // string concatenation via a non-numeric persisted value. `migrate`
      // covers version-mismatched blobs; `merge` covers same-version blobs,
      // which zustand hands straight to the default shallow merge otherwise
      // (mirrors `search-history.ts`).
      migrate: (persisted, _version) => coercePersistedPageBrowserFilters(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedPageBrowserFilters(persisted),
      }),
    },
  ),
)

/** Drop the space's journal chip, so a journal page revealed in the Pages view shows. */
export function removeExcludeJournalPagesFilter(spaceId: string | null): void {
  const state = usePageBrowserFiltersStore.getState()
  const index = selectPageFiltersForSpace(state, spaceId).findIndex(isExcludeJournalPagesFilter)
  if (index !== -1) state.removeFilter(spaceId ?? LEGACY_SPACE_KEY, index)
}
