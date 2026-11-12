/**
 * Navigation store: the current view, the one-shot `selectedBlockId`, the
 * handoff slots views consume on mount, and the header's Back / Forward
 * history.
 *
 * `currentView` mirrors the active space's `currentViewBySpace` slot, so each
 * space returns to the view last used in it; both persist, the flat field
 * serving the no-space boot path. `selectedBlockId` and the handoff slots are
 * transient and never persisted.
 *
 * Tab state lives in `useTabsStore` (`./tabs`). Tab actions call `setView`
 * here; this store never calls back into tabs.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { safePersistStorage } from '@/lib/safe-persist-storage'
import { createPerSpaceSlice } from '@/stores/createPerSpaceSlice'
import type { JournalMode } from '@/stores/journal'
import { LEGACY_SPACE_KEY } from '@/stores/space'
import type { View } from '@/types/view'

// The view-id type lives in `@/types/view` so `lib/` can use it without importing `stores/`.
export type { View } from '@/types/view'

/**
 * One step of the header's Back / Forward history: a journal period, a page
 * in a given tab, or any other view. Recorded and replayed by
 * `@/stores/navigation-history`.
 */
export type NavLocation =
  | { kind: 'journal'; mode: JournalMode; date: string }
  | { kind: 'page'; tabId: string; pageId: string; title: string }
  | { kind: 'view'; view: Exclude<View, 'journal' | 'page-editor'> }

/** The page a History view is scoped to. */
export interface HistoryPageScope {
  id: string
  title: string
}

export interface NavHistory {
  entries: NavLocation[]
  index: number
}

/** Oldest entries drop past this, so a long session cannot grow the list without bound. */
export const MAX_NAV_HISTORY = 100

const EMPTY_NAV_HISTORY: NavHistory = { entries: [], index: -1 }

interface NavigationStore {
  /** Active sidebar / content view. Mirrors `currentViewBySpace[currentSpaceId]`. */
  currentView: View
  /** Per-space view slices. Keyed by space id, with `__legacy__` for the no-space slot. */
  currentViewBySpace: Record<string, View>
  /** Optional block ID to highlight/scroll to after navigation. */
  selectedBlockId: string | null
  /**
   * Handoff slot: `CommandPalette`'s "Reveal in Pages view" writes it and
   * `PageBrowser` consumes and clears it on mount.
   */
  pendingPageBrowserFilter: string | null
  /**
   * Handoff slot for the Settings tab, written by the deep-link router and the
   * welcome modal before switching to `'settings'` (#734). `SettingsView`
   * subscribes while mounted, so it lands even when Settings is already shown.
   */
  pendingSettingsTab: string | null
  /**
   * Handoff slot: the property key whose unfit values Settings › Properties
   * opens, consumed by `UnfitPropertyValues` (#6206).
   */
  pendingPropertyReview: string | null
  /**
   * Handoff slot: the page the page menu's *Page history* opens, consumed by
   * `HistoryView` (#6535).
   */
  pendingHistoryPage: HistoryPageScope | null
  /**
   * Back / Forward history per space, since a page id means nothing in
   * another space. In memory only.
   */
  navHistoryBySpace: Record<string, NavHistory>

  /** Switch view; tabs are left as they are. */
  setView: (view: View) => void
  /** Set the selected block id (or `null`). */
  setSelectedBlockId: (id: string | null) => void
  /** Clear the selectedBlockId. */
  clearSelection: () => void
  /** Write or clear the pending Pages-view filter handoff slot. */
  setPendingPageBrowserFilter: (q: string | null) => void
  /** Write or clear the pending Settings-tab handoff slot (#734). */
  setPendingSettingsTab: (tab: string | null) => void
  /** Write or clear the pending property-review handoff slot (#6206). */
  setPendingPropertyReview: (key: string | null) => void
  /** Write or clear the pending page-history handoff slot (#6535). */
  setPendingHistoryPage: (page: HistoryPageScope | null) => void
  /** Replace a space's Back / Forward history. Written only by `@/stores/navigation-history`. */
  setNavHistory: (spaceKey: string, history: NavHistory) => void
}

type NavigationState = NavigationStore

/**
 * Every `View` member. The `satisfies Record<View, true>` makes a missing one
 * a compile error; otherwise `coerceView` would rewrite that view to
 * `'journal'` on every load.
 */
const ALL_VIEWS = Object.keys({
  journal: true,
  search: true,
  pages: true,
  tags: true,
  trash: true,
  history: true,
  templates: true,
  settings: true,
  graph: true,
  query: true,
  'page-editor': true,
} satisfies Record<View, true>) as readonly View[]

/**
 * A persisted value as a valid `View`, or `null`: `localStorage` can hold
 * anything, and a bare cast lets garbage reach `ViewDispatcher`. Exported for
 * the tabs store, which persists a `View` as each tab's `enteredFrom`.
 */
export function coerceView(raw: unknown): View | null {
  return typeof raw === 'string' && (ALL_VIEWS as readonly string[]).includes(raw)
    ? (raw as View)
    : null
}

/** Coerce a persisted value into a `Record<string, View>`, dropping invalid slots. */
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
 * Coerce a whole persisted blob field by field (#753). Both `migrate` and
 * `merge` call it: zustand runs `migrate` only on a version mismatch, so a
 * corrupt blob with the current version reaches `merge` raw. Idempotent.
 * `selectedBlockId` always comes back `null`.
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
  // A v2 blob seeds the `__legacy__` slot from the flat view.
  const currentViewBySpace =
    version < 3 && Object.keys(persistedBySpace).length === 0
      ? { [LEGACY_SPACE_KEY]: currentView }
      : persistedBySpace
  return { currentView, currentViewBySpace, selectedBlockId: null }
}

/** The Back / Forward history of `spaceKey`, empty when it has none yet. */
export function selectNavHistory(state: NavigationState, spaceKey: string): NavHistory {
  return state.navHistoryBySpace[spaceKey] ?? EMPTY_NAV_HISTORY
}

/**
 * The view for `spaceId`, falling back to the flat `currentView` mirror when
 * the slice is missing, so a partial `setState({ currentView })` (tests) still
 * renders.
 */
export function selectCurrentViewForSpace(state: NavigationState, spaceId: string | null): View {
  if (spaceId == null) return state.currentView
  return state.currentViewBySpace[spaceId] ?? state.currentView
}

/**
 * Per-space slice of the view. A switch to a never-visited space opens the
 * page editor, but the first `__legacy__` → real space hydration is the space
 * store waking up, not a switch, and keeps the current view.
 */
const navigationSlice = createPerSpaceSlice<NavigationState, View>({
  readMirror: (state) => state.currentView,
  writeMirror: (value) => ({ currentView: value }),
  getSlice: (state, key) => state.currentViewBySpace[key],
  setSlice: (state, key, value) => ({
    currentViewBySpace: { ...state.currentViewBySpace, [key]: value },
  }),
  fallback: ({ prevKey, current }) => (prevKey === LEGACY_SPACE_KEY ? current : 'page-editor'),
})

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      currentView: 'journal',
      currentViewBySpace: {},
      selectedBlockId: null,
      pendingPageBrowserFilter: null,
      pendingSettingsTab: null,
      pendingPropertyReview: null,
      pendingHistoryPage: null,
      navHistoryBySpace: {},

      setView: (view: View) => {
        set(navigationSlice.applyActive(get(), view))
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

      setPendingPropertyReview: (key: string | null) => {
        set({ pendingPropertyReview: key })
      },

      setPendingHistoryPage: (page: HistoryPageScope | null) => {
        set({ pendingHistoryPage: page })
      },

      setNavHistory: (spaceKey: string, history: NavHistory) => {
        set((state) => ({
          navHistoryBySpace: { ...state.navHistoryBySpace, [spaceKey]: history },
        }))
      },
    }),
    {
      name: 'agaric:navigation',
      version: 3,
      storage: safePersistStorage,
      partialize: (state) => ({
        currentView: state.currentView,
        currentViewBySpace: state.currentViewBySpace,
      }),
      migrate: (persisted: unknown, version: number) =>
        // Older blobs carried tab fields, now in `useTabsStore`; coercion drops
        // them. zustand calls `migrate` only on a version mismatch.
        coercePersistedNavigation(persisted, version) as NavigationState,
      // A same-version blob skips `migrate`, so coerce here too (#753).
      merge: (persisted, current) => ({
        ...current,
        ...coercePersistedNavigation(persisted, 3),
      }),
    },
  ),
)

/** Swap the flat `currentView` with the per-space slice on every space switch. */
navigationSlice.attach(useNavigationStore)
