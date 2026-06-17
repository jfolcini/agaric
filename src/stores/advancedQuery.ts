/**
 * Advanced-query working-set store (#1280 D1).
 *
 * The first dedicated advanced-query surface (`AdvancedQueryView`) lets the user
 * compose a flat conjunction of filter chips over the shared filter vocabulary
 * and run it against the live `run_advanced_query` engine. The chips are the
 * only working state in v1 (sort/group/aggregate controls, nested And/Or/Not and
 * saved views are D2/D3 follow-ups), so this store mirrors
 * `pageBrowserFilters.ts`: a per-space, in-memory chip list, deliberately kept
 * SEPARATE from the Pages chip store so the two surfaces don't share a working
 * set.
 *
 * Like the Pages store it is NOT persisted — the chips are a transient working
 * set, intentionally cleared on app restart — and it is partitioned by space id
 * (chip values reference space-scoped ids, so a space switch reads the new
 * space's slice and chips never cross spaces).
 */

import { create } from 'zustand'

import type { PageFilterWithKey } from '../components/PageBrowser/PageBrowserFilterRow'
import type { FilterPrimitive } from '../lib/tauri'
import { LEGACY_SPACE_KEY } from './space'

interface AdvancedQueryState {
  /** Per-space active chip lists, keyed by space id (`__legacy__` for no-space). */
  filtersBySpace: Record<string, PageFilterWithKey[]>
  /** Monotonic counter for the React-key-only `_addId` so keys stay unique across re-mounts. */
  nextAddId: number
  /** Append a chip to the space's list, de-duping structurally-identical chips. */
  addFilter: (spaceKey: string, filter: FilterPrimitive) => void
  /** Remove the chip at `index` from the space's list. */
  removeFilter: (spaceKey: string, index: number) => void
  /** Clear every chip for the space (no-op when already empty). */
  clearFilters: (spaceKey: string) => void
}

/**
 * Stable frozen empty fallback for an absent slice. Returning a fresh `[]` each
 * call would retrigger every consumer via `Object.is`, so the reference must
 * stay stable (mirrors `pageBrowserFilters`' `EMPTY_FILTERS`).
 */
const EMPTY_FILTERS: readonly PageFilterWithKey[] = Object.freeze([])

/**
 * Per-space chip selector. Pass `currentSpaceId` from `useSpaceStore`; `null`
 * (pre-bootstrap) maps to the `__legacy__` slot. Returns the stable frozen empty
 * array for an absent slice so the selector is referentially idempotent.
 */
export function selectAdvancedQueryFiltersForSpace(
  state: AdvancedQueryState,
  spaceId: string | null,
): PageFilterWithKey[] {
  const key = spaceId ?? LEGACY_SPACE_KEY
  return state.filtersBySpace[key] ?? (EMPTY_FILTERS as PageFilterWithKey[])
}

export const useAdvancedQueryStore = create<AdvancedQueryState>()((set) => ({
  filtersBySpace: {},
  nextAddId: 0,
  addFilter: (spaceKey, filter) =>
    set((state) => {
      const current = state.filtersBySpace[spaceKey] ?? []
      // Dedupe: strip the React-key-only `_addId` and compare a stable JSON
      // serialisation. Re-applying a structurally-identical chip is a no-op —
      // it would ship a duplicate Leaf to the IPC (an AND of a condition with
      // itself) and add a redundant pill.
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
}))
