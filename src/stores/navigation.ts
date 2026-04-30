/**
 * Navigation store — Zustand state for the active sidebar view + selected
 * block highlight (MAINT-127 split).
 *
 * Owns two pieces of state:
 *
 *  - `currentView` — which top-level view is rendered (`'journal'`,
 *    `'pages'`, `'page-editor'`, …). Persisted to localStorage so a
 *    re-launch lands on the same view the user was using.
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
 * Persist contract — MAINT-127 bumped from `version: 1` to `version: 2`.
 * The v1→v2 migrate function strips the now-removed tab fields from any
 * persisted blob so legacy users don't carry stale shape into the v2
 * layout. The companion `useTabsStore` starts FRESH for these users:
 * tabs persisted under v1 are dropped on first post-split boot. This is
 * the simpler of two strategies (the alternative would copy v1 tab
 * fields across to the new `agaric:tabs` key on rehydrate). One-time UX
 * cost: a returning user loses their tab list on first boot post-split
 * (tabs only — view + spaces survive). Acceptable for an early-stage
 * app with no production deployment.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

interface NavigationStore {
  /** Active sidebar / content view. */
  currentView: View
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

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set) => ({
      currentView: 'journal',
      selectedBlockId: null,

      setView: (view: View) => {
        set({ currentView: view })
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
      version: 2,
      // selectedBlockId is intentionally NOT persisted — it is a one-shot
      // UI affordance consumed and cleared by PageEditor / DailyView on
      // mount, not a setting that should survive relaunch.
      partialize: (state) => ({ currentView: state.currentView }),
      migrate: (persisted: unknown, version: number) => {
        // v0 → v1 (FEAT-3p3): the v1 migration moved tab data into the
        // per-space slices — that logic now lives in `useTabsStore` and
        // is irrelevant to this store post-split.
        //
        // v1 → v2 (MAINT-127): strip the now-removed tab fields from the
        // persisted blob so the rehydrated shape matches the slimmer v2
        // contract (`currentView` only). Users who previously had tabs
        // persisted will lose them ONCE on first post-split boot — see
        // the file header for the migration strategy + UX cost note.
        if (version >= 2) return persisted as NavigationState
        if (persisted == null || typeof persisted !== 'object') {
          return persisted as NavigationState
        }
        const old = persisted as { currentView?: View; selectedBlockId?: string | null }
        return {
          currentView: old.currentView ?? 'journal',
          selectedBlockId: null,
        } as NavigationState
      },
    },
  ),
)
