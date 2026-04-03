/**
 * Navigation store — Zustand state for page routing and view management.
 *
 * Tracks the active sidebar view, a breadcrumb stack for nested page
 * navigation, and an optional selected block (e.g. from search results).
 */

import { create } from 'zustand'

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
  | 'page-editor'

interface PageEntry {
  pageId: string
  title: string
}

interface NavigationStore {
  /** Active sidebar / content view. */
  currentView: View
  /** Breadcrumb stack for nested page navigation. */
  pageStack: PageEntry[]
  /** Optional block ID to highlight/scroll to after navigation. */
  selectedBlockId: string | null

  /** Switch sidebar view. Clears pageStack when leaving page-editor. */
  setView: (view: View) => void
  /** Push a page onto the stack and switch to page-editor. */
  navigateToPage: (pageId: string, title: string, blockId?: string) => void
  /** Pop the last page. If stack becomes empty, switch to 'pages'. */
  goBack: () => void
  /** Replace the top of the stack (e.g. after title edit). */
  replacePage: (pageId: string, title: string) => void
  /** Clear the selectedBlockId. */
  clearSelection: () => void
}

export const useNavigationStore = create<NavigationStore>((set, get) => ({
  currentView: 'journal',
  pageStack: [],
  selectedBlockId: null,

  setView: (view: View) => {
    const state = get()
    if (view !== 'page-editor' && state.currentView === 'page-editor') {
      // Leaving page-editor — clear the stack
      set({ currentView: view, pageStack: [], selectedBlockId: null })
    } else {
      set({ currentView: view })
    }
  },

  navigateToPage: (pageId: string, title: string, blockId?: string) => {
    const { pageStack } = get()
    const top = pageStack[pageStack.length - 1]
    if (top?.pageId === pageId) {
      set({ selectedBlockId: blockId ?? null })
      return
    }
    set({
      currentView: 'page-editor',
      pageStack: [...pageStack, { pageId, title }],
      selectedBlockId: blockId ?? null,
    })
  },

  goBack: () => {
    const { pageStack } = get()
    if (pageStack.length === 0) return

    const newStack = pageStack.slice(0, -1)
    if (newStack.length === 0) {
      set({ currentView: 'pages', pageStack: [], selectedBlockId: null })
    } else {
      set({ pageStack: newStack, selectedBlockId: null })
    }
  },

  replacePage: (pageId: string, title: string) => {
    const { pageStack } = get()
    if (pageStack.length === 0) return

    const newStack = [...pageStack]
    newStack[newStack.length - 1] = { pageId, title }
    set({ pageStack: newStack })
  },

  clearSelection: () => {
    set({ selectedBlockId: null })
  },
}))
