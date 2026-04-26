/**
 * Recent-pages store — Zustand state for the desktop-only "Recently visited"
 * strip (FEAT-9).
 *
 * Tracks up to `MAX_RETAINED` recent page visits in MRU order. Visits are
 * recorded by `useNavigationStore.navigateToPage`, the single entry point
 * for page navigation. Re-visiting the same pageId moves the existing entry
 * to the front (MRU dedup) and uses the new title, so stored titles always
 * reflect the most recent navigation.
 *
 * FEAT-3 Phase 3 — visits are partitioned by space. `recentPagesBySpace`
 * holds one MRU list per space id (with `__legacy__` for the no-space
 * slice); the flat `recentPages` field mirrors the active-space slice so
 * existing reads (and the `currentSpaceId == null` boot path) keep working
 * without forcing every consumer to thread the space id through.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSpaceStore } from './space'

export interface PageRef {
  pageId: string
  title: string
}

/**
 * How many recent visits are retained in the store. The UI renders a
 * responsive subset via CSS grid (`auto-fit` minmax(120px, 180px)) but keeps
 * a deeper list in memory so viewport width changes don't surprise the user
 * with vanished entries.
 */
const MAX_RETAINED = 10

/** Reserved key for the no-active-space slot. Mirrors `navigation.ts`. */
const LEGACY_SPACE_KEY = '__legacy__'

interface RecentPagesState {
  /**
   * Active-space MRU list — mirrors `recentPagesBySpace[currentSpaceId]`
   * after every `recordVisit`. Kept top-level so legacy reads work without
   * threading the space id; use `selectRecentPagesForSpace` for per-space
   * reads.
   */
  recentPages: PageRef[]
  /** Per-space MRU lists. Keyed by space id, with `__legacy__` for the no-space slice. */
  recentPagesBySpace: Record<string, PageRef[]>
  recordVisit: (pageRef: PageRef) => void
  /** Clear the MRU list for the active space (does not affect other spaces). */
  clear: () => void
}

type RecentState = RecentPagesState

/**
 * Per-space MRU selector. Pass `currentSpaceId` from `useSpaceStore`.
 *
 * Reads the per-space slice keyed by `spaceId`, falling back to the flat
 * `state.recentPages` field when the slice is missing. The flat field is
 * the active-space mirror — `recordVisit` writes both, and the space-
 * switch subscriber swaps the flat field on `currentSpaceId` change. The
 * fall-back lets a partial `setState({ recentPages })` (common in tests)
 * still render through this selector while the per-space slice
 * partitions data between non-active spaces.
 */
export function selectRecentPagesForSpace(state: RecentState, spaceId: string | null): PageRef[] {
  if (spaceId == null) return state.recentPages
  return state.recentPagesBySpace[spaceId] ?? state.recentPages
}

function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}

export const useRecentPagesStore = create<RecentPagesState>()(
  persist(
    (set, get) => ({
      recentPages: [],
      recentPagesBySpace: {},
      recordVisit: (ref) => {
        const state = get()
        const key = activeSpaceKey()
        // The flat field is the active-space mirror — same source of truth
        // as the navigation store. Read it (rather than the per-space slot)
        // so a partial setState in tests still drives the next visit.
        const current = state.recentPages
        const filtered = current.filter((p) => p.pageId !== ref.pageId)
        const next = [ref, ...filtered].slice(0, MAX_RETAINED)
        set({
          recentPages: next,
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: next },
        })
      },
      clear: () => {
        const state = get()
        const key = activeSpaceKey()
        set({
          recentPages: [],
          recentPagesBySpace: { ...state.recentPagesBySpace, [key]: [] },
        })
      },
    }),
    {
      name: 'agaric:recent-pages',
      version: 1,
      partialize: (state) => ({
        recentPages: state.recentPages,
        recentPagesBySpace: state.recentPagesBySpace,
      }),
      migrate: (persisted: unknown, version: number) => {
        // v0 → v1: pre-FEAT-3p3 stored only `recentPages`. Carry that flat
        // list into the `__legacy__` per-space slot so consumers that pass
        // `currentSpaceId = null` still see the user's history and the
        // per-space map gains a non-empty seed.
        if (version >= 1) return persisted as RecentState
        if (persisted == null || typeof persisted !== 'object') return persisted as RecentState
        const old = persisted as Partial<RecentState> & { recentPages?: PageRef[] }
        const recentPages = Array.isArray(old.recentPages) ? old.recentPages : []
        return {
          ...old,
          recentPages,
          recentPagesBySpace: old.recentPagesBySpace ?? { [LEGACY_SPACE_KEY]: recentPages },
        } as RecentState
      },
    },
  ),
)

/**
 * Subscribe once to `useSpaceStore` so the flat `recentPages` field swaps
 * with the per-space slice whenever the user switches space (mirrors the
 * navigation store's space-switch flush). Without this, switching from
 * space-A to space-B would leak A's MRU list into the active view.
 */
// `prevSpaceKey` is initialised lazily on the first subscriber fire to
// avoid the same module-load / persist-rehydration race documented in
// `navigation.ts`. On first fire we seed `recentPagesBySpace[newKey]`
// from the rehydrated flat list if it's missing, so a returning user
// migrated from version 0 retains their MRU under the active space.
let prevSpaceKey: string | undefined
useSpaceStore.subscribe((state) => {
  const newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY
  if (prevSpaceKey === undefined) {
    const recentState = useRecentPagesStore.getState()
    if (recentState.recentPagesBySpace[newKey] === undefined) {
      useRecentPagesStore.setState({
        recentPagesBySpace: {
          ...recentState.recentPagesBySpace,
          [newKey]: recentState.recentPages,
        },
      })
    }
    prevSpaceKey = newKey
    return
  }
  if (newKey === prevSpaceKey) return
  const recentState = useRecentPagesStore.getState()
  const flushedBySpace = {
    ...recentState.recentPagesBySpace,
    [prevSpaceKey]: recentState.recentPages,
  }
  const next = recentState.recentPagesBySpace[newKey] ?? []
  useRecentPagesStore.setState({
    recentPages: next,
    recentPagesBySpace: flushedBySpace,
  })
  prevSpaceKey = newKey
})
