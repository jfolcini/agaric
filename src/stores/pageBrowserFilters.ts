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
 *   pages — so a space switch reads the new space's slice, empty if none, and
 *   chips never cross spaces),
 * - survive an app restart (#1750): persisted to localStorage so the same
 *   "I set up a filter" gesture has the same lifetime as the graph view's
 *   filters (which already persist via `GraphFilterBar`'s `agaric:graph-filters`
 *   key). Backlinks deliberately stay page-scoped and reset on navigation; the
 *   two surfaces that own a durable filter set (graph + pages) now persist
 *   consistently.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { PageFilterWithKey } from '../components/PageBrowser/PageBrowserFilterRow'
import type { FilterPrimitive } from '../lib/tauri'
import { LEGACY_SPACE_KEY } from './space'

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

/**
 * Stable frozen empty fallback for an absent slice. Returning a fresh `[]` from
 * the selector each call would retrigger every consumer via `Object.is`, so the
 * reference must stay stable (mirrors `recent-pages`' `EMPTY_PAGE_REFS`).
 */
const EMPTY_FILTERS: readonly PageFilterWithKey[] = Object.freeze([])

/**
 * Per-space chip selector. Pass `currentSpaceId` from `useSpaceStore`; `null`
 * (pre-bootstrap) maps to the `__legacy__` slot. Returns the stable frozen
 * empty array for an absent slice so the selector is referentially idempotent.
 */
export function selectPageFiltersForSpace(
  state: PageBrowserFiltersState,
  spaceId: string | null,
): PageFilterWithKey[] {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.filtersBySpace[key] ?? (EMPTY_FILTERS as PageFilterWithKey[])
}

export const usePageBrowserFiltersStore = create<PageBrowserFiltersState>()(
  persist(
    (set) => ({
      filtersBySpace: {},
      nextAddId: 0,
      addFilter: (spaceKey, filter) =>
        set((state) => {
          const current = state.filtersBySpace[spaceKey] ?? []
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
          const current = state.filtersBySpace[spaceKey] ?? []
          return {
            filtersBySpace: {
              ...state.filtersBySpace,
              [spaceKey]: current.filter((_, i) => i !== index),
            },
          }
        }),
      clearFilters: (spaceKey) =>
        set((state) => {
          const current = state.filtersBySpace[spaceKey] ?? []
          if (current.length === 0) return state
          return {
            filtersBySpace: { ...state.filtersBySpace, [spaceKey]: [] },
          }
        }),
    }),
    {
      name: 'agaric:page-browser-filters',
      version: 1,
      // Persist the chip lists and the monotonic id counter so `_addId` keys
      // stay unique across a restart (a fresh 0 would collide with rehydrated
      // chips). Function members are not serialisable and are excluded.
      partialize: (state) => ({
        filtersBySpace: state.filtersBySpace,
        nextAddId: state.nextAddId,
      }),
    },
  ),
)
