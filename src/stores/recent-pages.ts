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

import { activeSpaceKey } from '../lib/active-space'
import { createSpaceSubscriber } from '../lib/createSpaceSubscriber'
import { LEGACY_SPACE_KEY } from './space'

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
 * Stable empty fallback used by `selectRecentPagesForSpace`. Returning a
 * fresh `[]` from a zustand selector each call retriggers every
 * `useSyncExternalStore` consumer (Object.is equality), which compounded
 * into a `Maximum update depth exceeded` in App-level tests. Keep the
 * reference stable so the selector is idempotent.
 *
 * Cast to mutable `PageRef[]` at the consumer boundary is safe — the
 * selector contract is read-only; every consumer treats the returned
 * array as immutable. We don't widen the public return type to
 * `readonly PageRef[]` to avoid a TS ripple across every consumer
 * (`QuickAccessBar`, `App.tsx`, tests).
 */
const EMPTY_PAGE_REFS: readonly PageRef[] = Object.freeze([])

/**
 * Per-space MRU selector. Pass `currentSpaceId` from `useSpaceStore`.
 *
 * Reads the per-space slice keyed by `spaceId`. When `spaceId` is null
 * (pre-bootstrap), falls back to the flat `recentPages` mirror so the
 * boot path still renders something. For a real space with no slice
 * yet, returns the shared empty array — the flat field may still hold
 * a different space's mirror if the space-switch subscriber hasn't run,
 * so falling back to it would leak cross-space entries into the strip.
 */
export function selectRecentPagesForSpace(state: RecentState, spaceId: string | null): PageRef[] {
  if (spaceId == null) return state.recentPages
  return state.recentPagesBySpace[spaceId] ?? (EMPTY_PAGE_REFS as PageRef[])
}

export const useRecentPagesStore = create<RecentPagesState>()(
  persist(
    (set, get) => ({
      recentPages: [],
      recentPagesBySpace: {},
      recordVisit: (ref) => {
        const state = get()
        const key = activeSpaceKey()
        // PEND-78: build the next MRU from the active space's OWN slice — the
        // single source of truth. Reading the flat mirror here was the
        // write-time corruption path: a stale flat field (another space's
        // list, e.g. after rehydrate) would be copied into this space's slice
        // and durably persisted.
        const current = state.recentPagesBySpace[key] ?? []
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
 * Flush the outgoing space's slice and pull the incoming space's slice into
 * the flat `recentPages` mirror on a space change. On first fire
 * (`prevKey === newKey`) it (a) seeds the legacy slot from the rehydrated
 * flat list for the v0→v1 path, then (b) reconciles the flat mirror to the
 * active space's slice — PEND-78 Defect 2: on rehydrate the flat field may
 * hold a *different* space's list (whichever was active when persistence
 * last ran), and leaving it stale leaks that list through the flat-field
 * read paths.
 *
 * MAINT-122: subscription mechanics + diff detection live in
 * `createSpaceSubscriber`; this callback owns only the recent-pages
 * flush/pull/reconcile. Exported because the module-level subscriber fires
 * its first-fire (seed) path once at import, so that path is otherwise
 * unreachable from the test runtime.
 */
export function reconcileRecentPagesOnSpaceChange(prevKey: string, newKey: string): void {
  const recentState = useRecentPagesStore.getState()
  if (prevKey === newKey) {
    if (
      newKey === LEGACY_SPACE_KEY &&
      recentState.recentPagesBySpace[newKey] === undefined &&
      recentState.recentPages.length > 0
    ) {
      useRecentPagesStore.setState({
        recentPagesBySpace: {
          ...recentState.recentPagesBySpace,
          [newKey]: recentState.recentPages,
        },
      })
      return
    }
    const slice = recentState.recentPagesBySpace[newKey] ?? []
    if (slice !== recentState.recentPages) {
      useRecentPagesStore.setState({ recentPages: slice })
    }
    return
  }
  const flushedBySpace = {
    ...recentState.recentPagesBySpace,
    [prevKey]: recentState.recentPages,
  }
  const next = recentState.recentPagesBySpace[newKey] ?? []
  useRecentPagesStore.setState({
    recentPages: next,
    recentPagesBySpace: flushedBySpace,
  })
}

createSpaceSubscriber(reconcileRecentPagesOnSpaceChange)
