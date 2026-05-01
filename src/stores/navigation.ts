/**
 * Navigation store — Zustand state for the active sidebar view + selected
 * block highlight (MAINT-127 split).
 *
 * Owns three pieces of state:
 *
 *  - `currentView` — which top-level view is rendered (`'journal'`,
 *    `'pages'`, `'page-editor'`, …). The active-space mirror of
 *    `currentViewBySpace[currentSpaceId]`. Persisted to localStorage so
 *    a re-launch lands on the same view the user was using.
 *  - `currentViewBySpace` — per-space view slice (FEAT-3p4). Switching
 *    space pulls `currentViewBySpace[newKey]` into the flat
 *    `currentView` field via the space-switch subscriber, so a user who
 *    last used `Search` in Personal lands on `Search` when they switch
 *    back to Personal — even if they were on `pages` in Work in the
 *    meantime. Persisted; the flat `currentView` is also persisted so
 *    legacy reads (and the no-active-space boot path) keep working.
 *  - `selectedBlockId` — optional block ID to highlight / scroll-to /
 *    focus after navigation. Set by `navigateToPage(…, blockId)` (which
 *    lives in `useTabsStore`) and consumed by `PageEditor` / `DailyView`
 *    on mount as a one-shot. NOT persisted — block-level selection is
 *    a transient UI affordance, not a layout choice.
 *
 * Tab state (page stacks, tabsBySpace, activeTabIndex, navigateToPage,
 * goBack, openInNewTab, closeTab, switchTab, replacePage) lives in
 * `useTabsStore` (`./tabs`). The split is asymmetric: tab actions
 * forward to this store via `useNavigationStore.getState().setView(...)`
 * when they imply a view change; this store's actions never reach back
 * into tabs.
 *
 * Persist contract — FEAT-3p4 bumped from `version: 2` to `version: 3`.
 * The v2→v3 migrate function seeds `currentViewBySpace[__legacy__]`
 * from the rehydrated flat `currentView` so users carrying v2 data
 * land on their last view (under the `__legacy__` slot) until the
 * space subscriber pulls the right per-space slot on first space
 * switch.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSpaceSubscriber } from '../lib/createSpaceSubscriber'
import { useSpaceStore } from './space'

export type View =
  | 'journal'
  | 'search'
  | 'pages'
  | 'tags'
  | 'properties'
  | 'trash'
  | 'status'
  | 'conflicts'
  | 'history'
  | 'templates'
  | 'settings'
  | 'graph'
  | 'page-editor'

/** Reserved key for the no-active-space slot. Mirrors `recent-pages.ts`. */
const LEGACY_SPACE_KEY = '__legacy__'

interface NavigationStore {
  /** Active sidebar / content view. Mirrors `currentViewBySpace[currentSpaceId]`. */
  currentView: View
  /** Per-space view slices. Keyed by space id, with `__legacy__` for the no-space slot. */
  currentViewBySpace: Record<string, View>
  /** Optional block ID to highlight/scroll to after navigation. */
  selectedBlockId: string | null

  /** Switch sidebar view. DON'T touch tabs (preserve them across view changes). */
  setView: (view: View) => void
  /** Set the selected block id (or `null`). */
  setSelectedBlockId: (id: string | null) => void
  /** Clear the selectedBlockId. */
  clearSelection: () => void
}

type NavigationState = NavigationStore

/**
 * Per-space view selector (FEAT-3p4). Pass `currentSpaceId` from
 * `useSpaceStore`.
 *
 * Reads the per-space slice keyed by `spaceId`, falling back to the flat
 * `state.currentView` field when the slice is missing. The flat field is
 * the active-space mirror — `setView` writes both, and the space-switch
 * subscriber swaps the flat field on `currentSpaceId` change. The
 * fall-back lets a partial `setState({ currentView })` (common in tests)
 * still render through this selector while the per-space slice
 * partitions data between non-active spaces.
 */
export function selectCurrentViewForSpace(state: NavigationState, spaceId: string | null): View {
  if (spaceId == null) return state.currentView
  return state.currentViewBySpace[spaceId] ?? state.currentView
}

function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      currentView: 'journal',
      currentViewBySpace: {},
      selectedBlockId: null,

      setView: (view: View) => {
        const state = get()
        const key = activeSpaceKey()
        set({
          currentView: view,
          currentViewBySpace: { ...state.currentViewBySpace, [key]: view },
        })
      },

      setSelectedBlockId: (id: string | null) => {
        set({ selectedBlockId: id })
      },

      clearSelection: () => {
        set({ selectedBlockId: null })
      },
    }),
    {
      name: 'agaric:navigation',
      version: 3,
      // selectedBlockId is intentionally NOT persisted — it is a one-shot
      // UI affordance consumed and cleared by PageEditor / DailyView on
      // mount, not a setting that should survive relaunch.
      partialize: (state) => ({
        currentView: state.currentView,
        currentViewBySpace: state.currentViewBySpace,
      }),
      migrate: (persisted: unknown, version: number) => {
        // v0 → v1 (FEAT-3p3): the v1 migration moved tab data into the
        // per-space slices — that logic now lives in `useTabsStore` and
        // is irrelevant to this store post-split.
        //
        // v1 → v2 (MAINT-127): strip the now-removed tab fields from the
        // persisted blob so the rehydrated shape matches the slimmer v2
        // contract (`currentView` only).
        //
        // v2 → v3 (FEAT-3p4): seed `currentViewBySpace[__legacy__]` from
        // the rehydrated flat `currentView` so a returning user lands on
        // their last view until the space subscriber pulls the proper
        // per-space slot on first space switch.
        if (version >= 3) return persisted as NavigationState
        if (persisted == null || typeof persisted !== 'object') {
          return persisted as NavigationState
        }
        const old = persisted as {
          currentView?: View
          currentViewBySpace?: Record<string, View>
          selectedBlockId?: string | null
        }
        const currentView = old.currentView ?? 'journal'
        const currentViewBySpace = old.currentViewBySpace ?? { [LEGACY_SPACE_KEY]: currentView }
        return {
          currentView,
          currentViewBySpace,
          selectedBlockId: null,
        } as NavigationState
      },
    },
  ),
)

/**
 * Subscribe once to `useSpaceStore` so the flat `currentView` field
 * swaps with the per-space slice whenever the user switches space
 * (mirrors the recent-pages and tabs stores' space-switch flushes).
 * Without this, switching from space-A to space-B would leave A's
 * last view active in B's UI.
 *
 * MAINT-122: subscription mechanics + diff detection live in
 * `createSpaceSubscriber`; this site only owns the navigation flush /
 * pull logic. On first fire (`prevKey === newKey`) we seed
 * `currentViewBySpace[newKey]` from the rehydrated flat `currentView`
 * if it's missing, so a returning user migrated from a v2 shape
 * (where view existed only in the flat field) lands on their last
 * view in the now-active space.
 */
createSpaceSubscriber((prevKey, newKey) => {
  const navState = useNavigationStore.getState()
  if (prevKey === newKey) {
    if (navState.currentViewBySpace[newKey] === undefined) {
      useNavigationStore.setState({
        currentViewBySpace: {
          ...navState.currentViewBySpace,
          [newKey]: navState.currentView,
        },
      })
    }
    return
  }
  const flushedBySpace = {
    ...navState.currentViewBySpace,
    [prevKey]: navState.currentView,
  }
  // Default new-space view to `page-editor` for fresh spaces — matches
  // the locked-in plan: "default `page-editor` for fresh spaces". Existing
  // spaces with a recorded view get their last view back.
  const next = navState.currentViewBySpace[newKey] ?? 'page-editor'
  useNavigationStore.setState({
    currentView: next,
    currentViewBySpace: flushedBySpace,
  })
})
