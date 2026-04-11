/**
 * Navigation store — Zustand state for page routing and view management.
 *
 * Tracks the active sidebar view, a breadcrumb stack for nested page
 * navigation (per-tab), and an optional selected block (e.g. from search results).
 *
 * Multiple editor tabs are supported. Each tab has its own page stack.
 * Only one tab is active at a time, preserving the single TipTap editor invariant.
 * Use `selectPageStack` to derive the active tab's page stack from the store state.
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

interface NavigationStore {
  /** Active sidebar / content view. */
  currentView: View
  /** All open tabs. */
  tabs: Tab[]
  /** Index of the currently active tab. */
  activeTabIndex: number
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
  /** Switch to a different tab by index. */
  switchTab: (tabIndex: number) => void
}

/** Selector: active tab's page stack. Always in sync — no dual state. */
export function selectPageStack(state: NavigationStore): PageEntry[] {
  return state.tabs[state.activeTabIndex]?.pageStack ?? []
}

/** Derive a tab label from its page stack. */
function tabLabel(stack: PageEntry[]): string {
  const top = stack[stack.length - 1]
  return top?.title ?? ''
}

export const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      currentView: 'journal',
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
      selectedBlockId: null,

      setView: (view: View) => {
        const state = get()
        if (view !== 'page-editor' && state.currentView === 'page-editor') {
          // Leaving page-editor — clear the stacks and tabs
          set({
            currentView: view,
            tabs: [{ id: '0', pageStack: [], label: '' }],
            activeTabIndex: 0,
            selectedBlockId: null,
          })
        } else {
          set({ currentView: view })
        }
      },

      navigateToPage: (pageId: string, title: string, blockId?: string) => {
        const state = get()
        const { tabs, activeTabIndex } = state
        const activeTab = tabs[activeTabIndex]
        if (!activeTab) return

        const pageStack = selectPageStack(state)
        const top = pageStack[pageStack.length - 1]
        if (top?.pageId === pageId) {
          set({ selectedBlockId: blockId ?? null })
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
          tabs: newTabs,
          selectedBlockId: blockId ?? null,
        })
      },

      goBack: () => {
        const state = get()
        const { tabs, activeTabIndex } = state
        const pageStack = selectPageStack(state)
        if (pageStack.length === 0) return

        const newStack = pageStack.slice(0, -1)
        const activeTab = tabs[activeTabIndex]
        if (newStack.length === 0) {
          // If there are other tabs, close this one and switch
          if (tabs.length > 1) {
            const newTabs = tabs.filter((_, i) => i !== activeTabIndex)
            const newIndex = Math.min(activeTabIndex, newTabs.length - 1)
            set({
              tabs: newTabs,
              activeTabIndex: newIndex,
              selectedBlockId: null,
            })
          } else {
            // Last tab — switch to pages view
            const newTabs = [{ id: activeTab?.id ?? '0', pageStack: [], label: '' }]
            set({
              currentView: 'pages',
              tabs: newTabs,
              activeTabIndex: 0,
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
          set({ tabs: newTabs, selectedBlockId: null })
        }
      },

      replacePage: (pageId: string, title: string) => {
        const state = get()
        const { tabs, activeTabIndex } = state
        const pageStack = selectPageStack(state)
        if (pageStack.length === 0) return

        const newStack = [...pageStack]
        newStack[newStack.length - 1] = { pageId, title }
        const newTabs = [...tabs]
        const activeTab = tabs[activeTabIndex]
        if (activeTab) {
          newTabs[activeTabIndex] = {
            ...activeTab,
            pageStack: newStack,
            label: tabLabel(newStack),
          }
        }
        set({ tabs: newTabs })
      },

      clearSelection: () => {
        set({ selectedBlockId: null })
      },

      openInNewTab: (pageId: string, title: string) => {
        const state = get()
        const newStack: PageEntry[] = [{ pageId, title }]
        const newTab: Tab = {
          id: String(nextTabId++),
          pageStack: newStack,
          label: title,
        }
        const newTabs = [...state.tabs, newTab]
        const newIndex = newTabs.length - 1
        set({
          currentView: 'page-editor',
          tabs: newTabs,
          activeTabIndex: newIndex,
          selectedBlockId: null,
        })
      },

      closeTab: (tabIndex: number) => {
        const state = get()
        const { tabs, activeTabIndex } = state
        if (tabIndex < 0 || tabIndex >= tabs.length) return

        if (tabs.length <= 1) {
          // Closing last tab — go to pages view
          set({
            currentView: 'pages',
            tabs: [{ id: '0', pageStack: [], label: '' }],
            activeTabIndex: 0,
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
          tabs: newTabs,
          activeTabIndex: newIndex,
          selectedBlockId: null,
        })
      },

      switchTab: (tabIndex: number) => {
        const state = get()
        if (tabIndex < 0 || tabIndex >= state.tabs.length) return
        if (tabIndex === state.activeTabIndex) return
        set({
          activeTabIndex: tabIndex,
          selectedBlockId: null,
        })
      },
    }),
    {
      name: 'agaric:navigation',
      partialize: (state) => ({
        currentView: state.currentView,
        tabs: state.tabs,
        activeTabIndex: state.activeTabIndex,
      }),
      onRehydrateStorage: () => (state) => {
        // Derive nextTabId from persisted tabs to avoid ID collisions
        if (state?.tabs) {
          const maxId = state.tabs.reduce((max, tab) => {
            const id = Number.parseInt(tab.id, 10)
            return Number.isNaN(id) ? max : Math.max(max, id)
          }, 0)
          nextTabId = maxId + 1
        }
      },
    },
  ),
)

/** Reset the tab ID counter — useful for test determinism. */
export function resetTabIdCounter(): void {
  nextTabId = 1
}
