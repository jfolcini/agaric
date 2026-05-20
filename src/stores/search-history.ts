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
  /** Push a submitted query onto the active-space MRU list. No-op on empty. */
  push: (spaceId: string | null | undefined, query: string) => void
  /** Clear the MRU list for the given space (does not affect other spaces). */
  clear: (spaceId: string | null | undefined) => void
}

function spaceKey(spaceId: string | null | undefined): string {
  if (!spaceId) return LEGACY_HISTORY_SPACE_KEY
  return spaceId
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set) => ({
      bySpace: {},
      push: (spaceId, query) =>
        set((state) => {
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
    }),
    {
      name: 'agaric:search-history',
      version: 1,
      partialize: (state) => ({ bySpace: state.bySpace }),
      // PEND-73 Phase 4.R1 — no-op migrate placeholder. Locks the
      // contract: a future `version: 2` bump MUST replace this with
      // a real migration. Without the placeholder, zustand's persist
      // middleware silently wipes the persisted state on a version
      // mismatch and the user loses their MRU history.
      migrate: (persisted, _version) => persisted as Pick<SearchHistoryState, 'bySpace'>,
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
