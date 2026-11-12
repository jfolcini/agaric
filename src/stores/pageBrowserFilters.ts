/**
 * Pages view filter chips, per space and persisted (#1750). Out of component
 * state because opening the editor unmounts the view and reset them, and a
 * space switch leaked one space's chips into another; persisted so they last
 * as long as the graph view's filters. A space with no stored slice reads as
 * `DEFAULT_PAGE_FILTERS` (#5370); a stored `[]` is the user having removed it.
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
  /** Monotonic source of the React-key-only `_addId`, so chip keys stay unique across mounts. */
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
 * Stable default for an absent slice: a fresh array per call would fail
 * `Object.is` and re-render every consumer. `_addId` 0 is never minted, as
 * `addFilter` pre-increments.
 */
const DEFAULT_PAGE_FILTERS: readonly PageFilterWithKey[] = Object.freeze([
  { ...EXCLUDE_JOURNAL_PAGES_FILTER, _addId: 0 },
])

/** Light structural check; a full `FilterPrimitive` match is not worth duplicating here. */
function isPageFilterWithKeyLike(value: unknown): value is PageFilterWithKey {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['type'] === 'string' && typeof v['_addId'] === 'number'
}

/**
 * Coerce a persisted value into a valid `filtersBySpace`, dropping non-array
 * slices and entries that do not look like a chip. An empty slice is kept:
 * dropping it would bring the default back.
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
 * Coerce a whole persisted blob field by field. Both `migrate` and `merge`
 * call it: zustand runs `migrate` only on a version mismatch, so a corrupt blob
 * with the current version reaches `merge` raw. Idempotent.
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

/** Per-space chips; a null space maps to `__legacy__`, an absent slice to the stable default. */
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
          // A structurally identical chip would AND a condition with itself.
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
      // The counter persists too: restarting from 0 would collide with rehydrated chips.
      partialize: (state) => ({
        filtersBySpace: state.filtersBySpace,
        nextAddId: state.nextAddId,
      }),
      // A corrupt blob must not crash PageBrowser on a non-array slice or turn
      // `nextAddId` into string concatenation (#3323).
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
