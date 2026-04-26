/**
 * Navigation store — Zustand state for page routing and view management.
 *
 * Tracks the active sidebar view, a breadcrumb stack for nested page
 * navigation (per-tab), and an optional selected block (e.g. from search results).
 *
 * Multiple editor tabs are supported. Each tab has its own page stack.
 * Only one tab is active at a time, preserving the single TipTap editor invariant.
 * Use `selectPageStack` to derive the active tab's page stack from the store state.
 *
 * FEAT-3 Phase 3 — tabs are partitioned by space. `tabsBySpace` and
 * `activeTabIndexBySpace` hold one slice per space id; the flat `tabs` /
 * `activeTabIndex` fields mirror the active-space slice and serve as the
 * legacy view when no space is active (`currentSpaceId == null`). Consumers
 * read via `selectTabsForSpace` / `selectActiveTabIndexForSpace` so a tab
 * opened in space-A never leaks into space-B.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isDateFormattedPage } from '../lib/date-utils'
import { parseDate } from '../lib/parse-date'
import { useJournalStore } from './journal'
import { useRecentPagesStore } from './recent-pages'
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

export interface PageEntry {
  pageId: string
  title: string
}

export interface Tab {
  id: string
  pageStack: PageEntry[]
  label: string
}

let nextTabId = 1

/**
 * Reserved key used for the "no active space" slice. Migrations from the
 * pre-FEAT-3p3 single-list shape land their tabs here; if a user boots
 * without `currentSpaceId` set (early boot, or no spaces yet) actions
 * read/write this slice rather than dropping data on the floor.
 */
const LEGACY_SPACE_KEY = '__legacy__'

interface NavigationStore {
  /** Active sidebar / content view. */
  currentView: View
  /**
   * Active-space tab list — mirrors `tabsBySpace[currentSpaceId]` after
   * every action. Kept as a top-level field so legacy reads (and the
   * `currentSpaceId == null` boot path) keep working without forcing every
   * consumer to thread the space id through. Use `selectTabsForSpace` for
   * per-space reads.
   */
  tabs: Tab[]
  /** Active-space active tab index — mirrors `activeTabIndexBySpace[currentSpaceId]`. */
  activeTabIndex: number
  /** Per-space tab lists. Keyed by space id, with `__legacy__` for the no-space slice. */
  tabsBySpace: Record<string, Tab[]>
  /** Per-space active-tab indices. Keyed identically to `tabsBySpace`. */
  activeTabIndexBySpace: Record<string, number>
  /** Optional block ID to highlight/scroll to after navigation. */
  selectedBlockId: string | null

  /** Switch sidebar view. DON'T clear tabs when leaving page-editor (preserve them). */
  setView: (view: View) => void
  /** Push a page onto the active tab's stack and switch to page-editor. */
  navigateToPage: (pageId: string, title: string, blockId?: string) => void
  /** Pop the last page from the active tab. If stack becomes empty, close tab or switch to 'pages'. */
  goBack: () => void
  /** Replace the top of the active tab's stack (e.g. after title edit). */
  replacePage: (pageId: string, title: string) => void
  /** Clear the selectedBlockId. */
  clearSelection: () => void
  /** Open a page in a new tab and switch to it. */
  openInNewTab: (pageId: string, title: string) => void
  /** Close a tab by index. If last tab closed, switch to 'pages' view. */
  closeTab: (tabIndex: number) => void
  /**
   * Switch to a different tab by index. When invoked from a non-`page-editor`
   * view, also flips `currentView` back to `page-editor` so the user actually
   * sees the tab's page content (FEAT-7 — shell-level TabBar hoist).
   */
  switchTab: (tabIndex: number) => void
}

type NavigationState = NavigationStore

/** Selector: active tab's page stack. Always in sync — no dual state. */
export function selectPageStack(state: NavigationStore): PageEntry[] {
  return state.tabs[state.activeTabIndex]?.pageStack ?? []
}

/**
 * Per-space tab list selector. Pass `currentSpaceId` from `useSpaceStore`.
 *
 * Reads the per-space slice keyed by `spaceId`, falling back to the flat
 * `state.tabs` field when the slice is missing. The flat field is the
 * active-space mirror — every action writes it alongside the per-space
 * slice, and the space-switch subscriber (`useSpaceStore.subscribe`)
 * keeps it pointing at whichever space is currently active. The fall-
 * back is what lets a partial `setState({ tabs })` (common in tests)
 * still render through this selector, while the per-space slice
 * partitions data between non-active spaces.
 */
export function selectTabsForSpace(state: NavigationState, spaceId: string | null): Tab[] {
  if (spaceId == null) return state.tabs
  return state.tabsBySpace[spaceId] ?? state.tabs
}

/** Per-space active-tab-index selector. Mirrors `selectTabsForSpace`. */
export function selectActiveTabIndexForSpace(
  state: NavigationState,
  spaceId: string | null,
): number {
  if (spaceId == null) return state.activeTabIndex
  return state.activeTabIndexBySpace[spaceId] ?? state.activeTabIndex
}

/** Resolve the active per-space key, falling back to the legacy slot. */
function activeSpaceKey(): string {
  return useSpaceStore.getState().currentSpaceId ?? LEGACY_SPACE_KEY
}

/** Default tab list — a single empty tab. Mirrors the initial state. */
function emptyTabList(): Tab[] {
  return [{ id: '0', pageStack: [], label: '' }]
}

/** Derive a tab label from its page stack. */
function tabLabel(stack: PageEntry[]): string {
  const top = stack[stack.length - 1]
  return top?.title ?? ''
}

/**
 * UX-242: parse a `YYYY-MM-DD` page title into a local-time `Date` when the
 * title is both shape-correct (`isDateFormattedPage`) AND resolves to a valid
 * calendar date (`parseDate` returns null for impossible dates like
 * `2026-13-45`). Returns `null` for any other input so callers can fall
 * through to the generic page-editor path.
 */
function parseDateTitleToLocalDate(title: string): Date | null {
  if (!isDateFormattedPage(title)) return null
  const parsed = parseDate(title)
  if (parsed === null) return null
  const parts = parsed.split('-')
  if (parts.length !== 3) return null
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Read the active-space tabs/index for an action. The flat `state.tabs`
 * field is the source of truth for the active space — every action writes
 * it alongside the per-space slice (`spliceTabs`) and the space-switch
 * subscriber (below) keeps it in sync when `currentSpaceId` changes. We
 * prefer the flat fields here so a partial `setState({ tabs })` (common in
 * tests) drives the next action instead of resurrecting whatever stale
 * data may linger in the per-space slice from an earlier action.
 */
function readActiveSlice(state: NavigationState): { tabs: Tab[]; activeTabIndex: number } {
  const tabs = state.tabs ?? emptyTabList()
  const activeTabIndex = state.activeTabIndex ?? 0
  return { tabs, activeTabIndex }
}

/**
 * Compose the next state object that updates BOTH the per-space slice and
 * the flat current-view mirror. Used by every action so the two views
 * never drift.
 */
function spliceTabs(
  state: NavigationState,
  tabs: Tab[],
  activeTabIndex: number,
): Pick<NavigationState, 'tabs' | 'activeTabIndex' | 'tabsBySpace' | 'activeTabIndexBySpace'> {
  const key = activeSpaceKey()
  return {
    tabs,
    activeTabIndex,
    tabsBySpace: { ...state.tabsBySpace, [key]: tabs },
    activeTabIndexBySpace: { ...state.activeTabIndexBySpace, [key]: activeTabIndex },
  }
}

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      currentView: 'journal',
      tabs: emptyTabList(),
      activeTabIndex: 0,
      tabsBySpace: {},
      activeTabIndexBySpace: {},
      selectedBlockId: null,

      setView: (view: View) => {
        set({ currentView: view })
      },

      navigateToPage: (pageId: string, title: string, blockId?: string) => {
        // FEAT-9: record every navigateToPage call as a recent-visit. The
        // store dedups by pageId, so repeated visits stay MRU-correct. Note
        // that we record the visit BEFORE the date-routed branch short-
        // circuits into Journal — date-titled pages (YYYY-MM-DD) are page
        // visits too.
        useRecentPagesStore.getState().recordVisit({ pageId, title })

        // UX-242: date-titled pages (YYYY-MM-DD) belong to the Journal → Daily
        // view, not the generic page-editor. Route them through the journal
        // store so every call site (PageBrowser, breadcrumbs, search, tag
        // filter, templates, graph, …) gets the correct behaviour with a
        // single change. Date-shaped titles that resolve to invalid calendar
        // dates (e.g. "2026-13-45") fall through to the page-editor path
        // below so the user can still reach the page.
        const parsedDate = parseDateTitleToLocalDate(title)
        if (parsedDate !== null) {
          useJournalStore.getState().navigateToDate(parsedDate, 'daily')
          // Journal view does not use pageStack at all, so we never push
          // onto it here. Tabs / activeTabIndex are preserved (UX-251).
          // UX-258: DailyView reads selectedBlockId on mount and scrolls
          // the matching block into view + restores focus, then clears
          // the selection (one-shot). See src/components/journal/DailyView.tsx.
          set({
            currentView: 'journal',
            selectedBlockId: blockId ?? null,
          })
          return
        }

        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const activeTab = tabs[activeTabIndex]
        if (!activeTab) return

        const pageStack = activeTab.pageStack
        const top = pageStack[pageStack.length - 1]
        if (top?.pageId === pageId) {
          // The page is already at the top of the stack, but the user may
          // have switched away to another view (Pages, Tags, Journal, …)
          // in the meantime. Ensure `currentView` flips back to
          // `page-editor` so clicking the same page in the browser
          // actually re-renders it instead of leaving the user stranded
          // on the previous view.
          set({ currentView: 'page-editor', selectedBlockId: blockId ?? null })
          return
        }

        const newStack = [...pageStack, { pageId, title }]
        const newTabs = [...tabs]
        newTabs[activeTabIndex] = {
          ...activeTab,
          pageStack: newStack,
          label: tabLabel(newStack),
        }
        set({
          currentView: 'page-editor',
          ...spliceTabs(state, newTabs, activeTabIndex),
          selectedBlockId: blockId ?? null,
        })
      },

      goBack: () => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const activeTab = tabs[activeTabIndex]
        const pageStack = activeTab?.pageStack ?? []
        if (pageStack.length === 0) return

        const newStack = pageStack.slice(0, -1)
        if (newStack.length === 0) {
          // If there are other tabs, close this one and switch
          if (tabs.length > 1) {
            const newTabs = tabs.filter((_, i) => i !== activeTabIndex)
            const newIndex = Math.min(activeTabIndex, newTabs.length - 1)
            set({
              ...spliceTabs(state, newTabs, newIndex),
              selectedBlockId: null,
            })
          } else {
            // Last tab — switch to pages view
            const newTabs = [{ id: activeTab?.id ?? '0', pageStack: [], label: '' }]
            set({
              currentView: 'pages',
              ...spliceTabs(state, newTabs, 0),
              selectedBlockId: null,
            })
          }
        } else {
          const newTabs = [...tabs]
          if (activeTab) {
            newTabs[activeTabIndex] = {
              ...activeTab,
              pageStack: newStack,
              label: tabLabel(newStack),
            }
          }
          set({
            ...spliceTabs(state, newTabs, activeTabIndex),
            selectedBlockId: null,
          })
        }
      },

      replacePage: (pageId: string, title: string) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        const activeTab = tabs[activeTabIndex]
        const pageStack = activeTab?.pageStack ?? []
        if (pageStack.length === 0) return

        const newStack = [...pageStack]
        newStack[newStack.length - 1] = { pageId, title }
        const newTabs = [...tabs]
        if (activeTab) {
          newTabs[activeTabIndex] = {
            ...activeTab,
            pageStack: newStack,
            label: tabLabel(newStack),
          }
        }
        set(spliceTabs(state, newTabs, activeTabIndex))
      },

      clearSelection: () => {
        set({ selectedBlockId: null })
      },

      openInNewTab: (pageId: string, title: string) => {
        const state = get()
        const { tabs } = readActiveSlice(state)
        const newStack: PageEntry[] = [{ pageId, title }]
        const newTab: Tab = {
          id: String(nextTabId++),
          pageStack: newStack,
          label: title,
        }
        const newTabs = [...tabs, newTab]
        const newIndex = newTabs.length - 1
        set({
          currentView: 'page-editor',
          ...spliceTabs(state, newTabs, newIndex),
          selectedBlockId: null,
        })
      },

      closeTab: (tabIndex: number) => {
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        if (tabIndex < 0 || tabIndex >= tabs.length) return

        if (tabs.length <= 1) {
          // Closing last tab — go to pages view
          set({
            currentView: 'pages',
            ...spliceTabs(state, emptyTabList(), 0),
            selectedBlockId: null,
          })
          return
        }

        const newTabs = tabs.filter((_, i) => i !== tabIndex)
        let newIndex: number
        if (tabIndex < activeTabIndex) {
          newIndex = activeTabIndex - 1
        } else if (tabIndex === activeTabIndex) {
          newIndex = Math.min(activeTabIndex, newTabs.length - 1)
        } else {
          newIndex = activeTabIndex
        }
        set({
          ...spliceTabs(state, newTabs, newIndex),
          selectedBlockId: null,
        })
      },

      switchTab: (tabIndex: number) => {
        // FEAT-7: TabBar is hoisted to the app shell and visible from any view
        // (journal, pages, search, …). Clicking a tab from a non-editor view
        // must flip `currentView` back to `page-editor` so the user actually
        // sees the tab's page content. When already in `page-editor` the
        // same-tab branch stays a pure no-op (preserves existing semantics).
        const state = get()
        const { tabs, activeTabIndex } = readActiveSlice(state)
        if (tabIndex < 0 || tabIndex >= tabs.length) return
        const inEditor = state.currentView === 'page-editor'
        const sameTab = tabIndex === activeTabIndex
        if (sameTab && inEditor) return
        if (sameTab) {
          // Cross-view click on the already-active tab: just flip the view.
          set({ currentView: 'page-editor' })
          return
        }
        if (inEditor) {
          set({
            ...spliceTabs(state, tabs, tabIndex),
            selectedBlockId: null,
          })
          return
        }
        set({
          currentView: 'page-editor',
          ...spliceTabs(state, tabs, tabIndex),
          selectedBlockId: null,
        })
      },
    }),
    {
      name: 'agaric:navigation',
      version: 1,
      partialize: (state) => ({
        currentView: state.currentView,
        tabs: state.tabs,
        activeTabIndex: state.activeTabIndex,
        tabsBySpace: state.tabsBySpace,
        activeTabIndexBySpace: state.activeTabIndexBySpace,
      }),
      migrate: (persisted: unknown, version: number) => {
        // v0 → v1: pre-FEAT-3p3 stored only `tabs` + `activeTabIndex`.
        // Carry that flat list into the `__legacy__` per-space slot so
        // selectors that pass `currentSpaceId = null` still see the
        // user's tabs, and the per-space maps gain a non-empty seed.
        if (version >= 1) return persisted as NavigationState
        if (persisted == null || typeof persisted !== 'object') return persisted as NavigationState
        const old = persisted as Partial<NavigationState> & {
          tabs?: Tab[]
          activeTabIndex?: number
        }
        const tabs = Array.isArray(old.tabs) ? old.tabs : emptyTabList()
        const activeTabIndex = typeof old.activeTabIndex === 'number' ? old.activeTabIndex : 0
        return {
          ...old,
          tabs,
          activeTabIndex,
          tabsBySpace: old.tabsBySpace ?? { [LEGACY_SPACE_KEY]: tabs },
          activeTabIndexBySpace: old.activeTabIndexBySpace ?? {
            [LEGACY_SPACE_KEY]: activeTabIndex,
          },
        } as NavigationState
      },
      onRehydrateStorage: () => (state) => {
        // Derive nextTabId from every persisted tab (across all spaces) to
        // avoid ID collisions after a per-space rehydrate.
        if (!state) return
        const idStreams: Tab[][] = []
        if (Array.isArray(state.tabs)) idStreams.push(state.tabs)
        if (state.tabsBySpace) {
          for (const slice of Object.values(state.tabsBySpace)) {
            if (Array.isArray(slice)) idStreams.push(slice)
          }
        }
        const maxId = idStreams.flat().reduce((max, tab) => {
          const id = Number.parseInt(tab.id, 10)
          return Number.isNaN(id) ? max : Math.max(max, id)
        }, 0)
        nextTabId = maxId + 1
      },
    },
  ),
)

/** Reset the tab ID counter — useful for test determinism. */
export function resetTabIdCounter(): void {
  nextTabId = 1
}

/**
 * Subscribe once to `useSpaceStore` so the flat `tabs` / `activeTabIndex`
 * fields swap with the per-space slice whenever the user switches space.
 *
 *   - Flush the outgoing space's flat fields into `tabsBySpace[oldKey]`.
 *   - Pull `tabsBySpace[newKey]` (if any) into the flat fields, defaulting
 *     to a single empty tab when the new space has never been visited.
 *
 * This keeps reads (`selectTabsForSpace`, `selectPageStack`, every consumer
 * that reads the flat field) consistent with whichever space the user is
 * currently on, without forcing every consumer to thread the space id.
 */
// `prevSpaceKey` is initialised lazily on the first subscriber fire so we
// don't sample `useSpaceStore.getState().currentSpaceId` at module-load
// time (which races with Zustand's async persist rehydration — the space
// store may rehydrate AFTER the navigation store and would otherwise
// trigger a spurious flush of the just-rehydrated flat tabs into the
// `__legacy__` slice).  On first fire we also seed `tabsBySpace[newKey]`
// from the rehydrated flat tabs if it's missing, so a returning user who
// migrated from version 0 (where their tabs only exist under the
// `__legacy__` key) keeps their tabs accessible from the active space.
let prevSpaceKey: string | undefined
useSpaceStore.subscribe((state) => {
  const newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY
  if (prevSpaceKey === undefined) {
    const navState = useNavigationStore.getState()
    if (navState.tabsBySpace[newKey] === undefined) {
      useNavigationStore.setState({
        tabsBySpace: {
          ...navState.tabsBySpace,
          [newKey]: navState.tabs,
        },
        activeTabIndexBySpace: {
          ...navState.activeTabIndexBySpace,
          [newKey]: navState.activeTabIndex,
        },
      })
    }
    prevSpaceKey = newKey
    return
  }
  if (newKey === prevSpaceKey) return
  const navState = useNavigationStore.getState()
  const flushedTabsBySpace = {
    ...navState.tabsBySpace,
    [prevSpaceKey]: navState.tabs,
  }
  const flushedIndexBySpace = {
    ...navState.activeTabIndexBySpace,
    [prevSpaceKey]: navState.activeTabIndex,
  }
  const newTabs = navState.tabsBySpace[newKey] ?? emptyTabList()
  const newIndex = navState.activeTabIndexBySpace[newKey] ?? 0
  useNavigationStore.setState({
    tabs: newTabs,
    activeTabIndex: newIndex,
    tabsBySpace: flushedTabsBySpace,
    activeTabIndexBySpace: flushedIndexBySpace,
    selectedBlockId: null,
  })
  prevSpaceKey = newKey
})
