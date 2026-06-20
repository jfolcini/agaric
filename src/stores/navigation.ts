/**
 * Navigation store — Zustand state for the active sidebar view + selected
 * Block highlight (split).
 *
 * Owns three pieces of state:
 *
 *  - `currentView` — which top-level view is rendered (`'journal'`,
 *    `'pages'`, `'page-editor'`, …). The active-space mirror of
 *    `currentViewBySpace[currentSpaceId]`. Persisted to localStorage so
 *    a re-launch lands on the same view the user was using.
 * `currentViewBySpace` — per-space view slice. Switching
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
 * Persist contract — bumped from `version: 2` to `version: 3`.
 * The v2→v3 migrate function seeds `currentViewBySpace[__legacy__]`
 * from the rehydrated flat `currentView` so users carrying v2 data
 * land on their last view (under the `__legacy__` slot) until the
 * space subscriber pulls the right per-space slot on first space
 * switch.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { activeSpaceKey } from '../lib/active-space'
import { createSpaceSubscriber } from '../lib/createSpaceSubscriber'
import { LEGACY_SPACE_KEY } from './space'

export type View =
  | 'journal'
  | 'search'
  | 'pages'
  | 'tags'
  | 'trash'
  | 'status'
  | 'history'
  | 'templates'
  | 'settings'
  | 'graph'
  | 'query'
  | 'page-editor'

interface NavigationStore {
  /** Active sidebar / content view. Mirrors `currentViewBySpace[currentSpaceId]`. */
  currentView: View
  /** Per-space view slices. Keyed by space id, with `__legacy__` for the no-space slot. */
  currentViewBySpace: Record<string, View>
  /** Optional block ID to highlight/scroll to after navigation. */
  selectedBlockId: string | null
  /**
   * Phase 5 follow-up — transient handoff slot consumed by
   * `PageBrowser` on mount. Written by `CommandPalette`'s
   * "Reveal in Pages view" action so the user lands on a pages list
   * already filtered to the page in question. The view reads and
   * clears this slot exactly once (same pattern as
   * `useCommandPaletteStore.pendingViewQuery`).
   */
  pendingPageBrowserFilter: string | null
  /**
   * #734 — transient handoff slot for the Settings panel's active tab.
   * Written by the deep-link router (`agaric://settings/<tab>`) and the
   * NoPeersDialog CTA BEFORE flipping `currentView` to `'settings'`.
   * `SettingsView` subscribes while mounted, so the request lands even
   * when Settings is already the current view (the localStorage +
   * `?settings=` mechanisms are only read in the useState initializer
   * and therefore no-op without a remount). Consumed-and-cleared
   * exactly once; NOT persisted (excluded from `partialize`).
   */
  pendingSettingsTab: string | null

  /** Switch sidebar view. DON'T touch tabs (preserve them across view changes). */
  setView: (view: View) => void
  /** Set the selected block id (or `null`). */
  setSelectedBlockId: (id: string | null) => void
  /** Clear the selectedBlockId. */
  clearSelection: () => void
  /** Write or clear the pending Pages-view filter handoff slot. */
  setPendingPageBrowserFilter: (q: string | null) => void
  /** Write or clear the pending Settings-tab handoff slot (#734). */
  setPendingSettingsTab: (tab: string | null) => void
}

type NavigationState = NavigationStore

/**
 * Every member of the `View` union — used by the CR-PERSIST coercers.
 * Derived from a `satisfies Record<View, true>` literal so that adding a
 * `View` member without listing it here is a compile error — a missing
 * member would make `coerceView` silently rewrite that view to the
 * `'journal'` default on every load.
 */
const ALL_VIEWS = Object.keys({
  journal: true,
  search: true,
  pages: true,
  tags: true,
  trash: true,
  status: true,
  history: true,
  templates: true,
  settings: true,
  graph: true,
  query: true,
  'page-editor': true,
} satisfies Record<View, true>) as readonly View[]

/**
 * CR-PERSIST — coerce an arbitrary persisted JSON value into a valid `View`,
 * or `null` if it isn't one. `localStorage` can hold anything (manual edits,
 * a corrupt write, a future-shape downgrade); hydrating a bare cast lets a
 * malformed blob reach `ViewDispatcher` as `currentView`.
 */
function coerceView(raw: unknown): View | null {
  return typeof raw === 'string' && (ALL_VIEWS as readonly string[]).includes(raw)
    ? (raw as View)
    : null
}

/** CR-PERSIST — coerce a persisted value into a `Record<string, View>`, dropping invalid slots. */
function coerceViewBySpace(raw: unknown): Record<string, View> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, View> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const view = coerceView(value)
    if (view) out[key] = view
  }
  return out
}

/**
 * CR-PERSIST (#753) — coerce an entire persisted navigation blob
 * field-by-field. Shared by `migrate` (version-mismatched blobs) and
 * `merge` (same-version blobs): zustand's persist middleware only calls
 * `migrate` when the stored version DIFFERS from `options.version`, so a
 * corrupt blob that still carries `version: 3` (or a non-numeric
 * version) bypasses `migrate` entirely and reaches the default shallow
 * `merge` raw — coercing in `merge` as well closes that path. The
 * coercion is idempotent, so the migrate→merge double pass on
 * version-mismatched blobs is harmless.
 *
 * `selectedBlockId` is always reset to `null` — it's a one-shot UI
 * affordance and is excluded from `partialize` anyway.
 */
function coercePersistedNavigation(
  persisted: unknown,
  version: number,
): Pick<NavigationState, 'currentView' | 'currentViewBySpace' | 'selectedBlockId'> {
  const blob = (persisted != null && typeof persisted === 'object' ? persisted : {}) as Record<
    string,
    unknown
  >
  const currentView = coerceView(blob['currentView']) ?? 'journal'
  const persistedBySpace = coerceViewBySpace(blob['currentViewBySpace'])
  // V2 → v3: seed `currentViewBySpace[__legacy__]` from the
  // flat `currentView` so a returning v2 user lands on their last view
  // until the space subscriber pulls the proper per-space slot.
  const currentViewBySpace =
    version < 3 && Object.keys(persistedBySpace).length === 0
      ? { [LEGACY_SPACE_KEY]: currentView }
      : persistedBySpace
  return { currentView, currentViewBySpace, selectedBlockId: null }
}

/**
 * Per-space view selector. Pass `currentSpaceId` from
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

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      currentView: 'journal',
      currentViewBySpace: {},
      selectedBlockId: null,
      pendingPageBrowserFilter: null,
      pendingSettingsTab: null,

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

      setPendingPageBrowserFilter: (q: string | null) => {
        set({ pendingPageBrowserFilter: q })
      },

      setPendingSettingsTab: (tab: string | null) => {
        set({ pendingSettingsTab: tab })
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
      migrate: (persisted: unknown, version: number) =>
        // V0 → v1: the v1 migration moved tab data into the
        // per-space slices — that logic now lives in `useTabsStore` and
        // is irrelevant to this store post-split.
        //
        // V1 → v2: strip the now-removed tab fields from the
        // persisted blob so the rehydrated shape matches the slimmer v2
        // contract (`currentView` only).
        //
        // CR-PERSIST (#753): EVERY version is coerced field-by-field
        // instead of bare-cast (previously a v>=3 blob was returned
        // `as NavigationState` unvalidated). Note zustand only invokes
        // `migrate` on a version MISMATCH — same-version blobs are
        // coerced by `merge` below.
        coercePersistedNavigation(persisted, version) as NavigationState,
      // CR-PERSIST (#753) — zustand skips `migrate` when the stored
      // version equals `options.version` (or isn't a number), handing the
      // raw blob straight to `merge`. Coerce here too so a corrupt
      // `localStorage` payload that still says `version: 3` (e.g.
      // `currentView: 42`) can't reach `ViewDispatcher`.
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedNavigation(persisted, 3),
      }),
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
 * Subscription mechanics + diff detection live in
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
  // The initial pre-hydration → first-real-space transition is NOT a
  // user-initiated space switch — it's just the space store waking up.
  // Treating it as a switch would flip `currentView` from the persisted /
  // default `'journal'` to `'page-editor'` (fresh-space default), which
  // is not what the user expects on first paint. Skip the flip for this
  // exact transition; the real-space-to-real-space switches that follow
  // still get the fresh-space default. (The seed `if (prevKey === newKey)`
  // branch above runs first via `fireImmediately: true`, so the
  // `currentViewBySpace[LEGACY_SPACE_KEY]` slot already records the
  // persisted `currentView` before this branch runs.)
  const flushedBySpace = {
    ...navState.currentViewBySpace,
    [prevKey]: navState.currentView,
  }
  if (prevKey === LEGACY_SPACE_KEY) {
    // Initial hydration — keep the current view, just flush the slot
    // mapping. If `currentViewBySpace[newKey]` happens to be recorded
    // already (returning user), still honour that.
    const persistedForNewSpace = navState.currentViewBySpace[newKey]
    useNavigationStore.setState({
      ...(persistedForNewSpace ? { currentView: persistedForNewSpace } : {}),
      currentViewBySpace: flushedBySpace,
    })
    return
  }
  // Real user-initiated space switch — default new-space view to
  // `page-editor` for fresh spaces. Existing spaces with a recorded view
  // get their last view back.
  const next = navState.currentViewBySpace[newKey] ?? 'page-editor'
  useNavigationStore.setState({
    currentView: next,
    currentViewBySpace: flushedBySpace,
  })
})
