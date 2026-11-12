/**
 * In-page find toolbar state. Matching lives in `InPageFind.tsx`, which walks
 * the registered `container` and reports counts through `setResult`; the
 * store stays free of DOM access. Unregistering the container (its view
 * unmounting) closes the toolbar. `lastQuery` survives `close()` so reopening
 * without a selection restores it; the replace row (#6608) hides on close and
 * keeps its text.
 */

import { create } from 'zustand'

import type { FindRegexError } from '@/lib/in-page-find/matcher'

export interface InPageFindToggles {
  caseSensitive: boolean
  wholeWord: boolean
  isRegex: boolean
}

interface InPageFindState {
  /** Whether the toolbar is mounted. */
  open: boolean
  /** Current find string. */
  query: string
  /** Toggle row state. */
  toggles: InPageFindToggles
  /** Number of matches in the last completed walk. */
  totalMatches: number
  /** Index of the "current" match (zero-based), or -1 when none. */
  currentIndex: number
  /** Discriminated regex failure (tooLong / tooSlow / invalid), or null. */
  regexError: FindRegexError | null
  /** Over-long text nodes the last regex walk skipped, for the "passages skipped" notice. */
  skippedLongNodes: number
  /** Page subtree to search. Registered by JournalPage / PageEditor. */
  container: HTMLElement | null
  /** Most-recent non-empty query — used to restore on re-open with no selection. */
  lastQuery: string
  /**
   * The block holding the current match, for the `BlockTree` that owns it to
   * mount (#6557: past the mount cap, under a collapsed block). Null when none.
   */
  revealBlockId: string | null
  /** Whether the replace row is shown. */
  replaceOpen: boolean
  /** The replace row's text. */
  replacement: string
  /** How many of the matches a replace would leave (in a chip); set by `useInPageReplace`. */
  unreplaceable: number

  /** Open the toolbar. If `selection` is provided, seed the query with it. */
  open$: (selection?: string) => void
  /** Close the toolbar; preserve `query` into `lastQuery`. */
  close: () => void
  /** Set the query string; recomputes via the InPageFind effect. */
  setQuery: (q: string) => void
  /** Update toggles partially. */
  setToggles: (next: Partial<InPageFindToggles>) => void
  /** Set the running counter state. Called by the matcher driver. */
  setResult: (info: {
    totalMatches: number
    currentIndex: number
    regexError: FindRegexError | null
    skippedLongNodes: number
  }) => void
  /** Move to the next match (wraps). */
  next: () => void
  /** Move to the previous match (wraps). */
  previous: () => void
  /** Register the host container (call with `null` to unregister). */
  setContainer: (el: HTMLElement | null) => void
  /** Ask the owning `BlockTree` to mount `blockId`'s row. */
  setRevealBlockId: (blockId: string | null) => void
  setReplaceOpen: (open: boolean) => void
  setReplacement: (text: string) => void
}

const initialToggles: InPageFindToggles = {
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
}

export const useInPageFindStore = create<InPageFindState>((set, get) => ({
  open: false,
  query: '',
  toggles: initialToggles,
  totalMatches: 0,
  currentIndex: -1,
  regexError: null,
  skippedLongNodes: 0,
  container: null,
  lastQuery: '',
  revealBlockId: null,
  replaceOpen: false,
  replacement: '',
  unreplaceable: 0,

  open$: (selection) => {
    const state = get()
    // The selection seeds the query; else the previous query returns, as in browsers.
    let nextQuery: string
    if (selection != null && selection.length > 0) {
      nextQuery = selection
    } else if (state.query.length > 0) {
      nextQuery = state.query
    } else {
      nextQuery = state.lastQuery
    }
    set({
      open: true,
      query: nextQuery,
      totalMatches: 0,
      currentIndex: nextQuery.length > 0 ? 0 : -1,
      regexError: null,
      skippedLongNodes: 0,
    })
  },

  close: () => {
    const state = get()
    set({
      open: false,
      lastQuery: state.query.length > 0 ? state.query : state.lastQuery,
      // Keep `query`, so a close and reopen without typing restores it.
      totalMatches: 0,
      currentIndex: -1,
      regexError: null,
      skippedLongNodes: 0,
      revealBlockId: null,
      replaceOpen: false,
    })
  },

  setQuery: (q) => {
    // An empty query resets the counter now, not after a stale "3 of 12".
    if (q.length === 0) {
      set({ query: q, totalMatches: 0, currentIndex: -1, regexError: null, skippedLongNodes: 0 })
      return
    }
    set({ query: q })
  },

  setToggles: (next) => {
    set((s) => ({ toggles: { ...s.toggles, ...next } }))
  },

  setResult: ({ totalMatches, currentIndex, regexError, skippedLongNodes }) => {
    set({ totalMatches, currentIndex, regexError, skippedLongNodes })
  },

  next: () => {
    const { totalMatches, currentIndex } = get()
    if (totalMatches === 0) return
    set({ currentIndex: (currentIndex + 1) % totalMatches })
  },

  previous: () => {
    const { totalMatches, currentIndex } = get()
    if (totalMatches === 0) return
    const prev = currentIndex <= 0 ? totalMatches - 1 : currentIndex - 1
    set({ currentIndex: prev })
  },

  setContainer: (el) => {
    const wasOpen = get().open
    // The view unmounted with the toolbar open: nothing to search, so close,
    // in one `set()`.
    if (el === null && wasOpen) {
      set({
        container: el,
        open: false,
        replaceOpen: false,
        totalMatches: 0,
        currentIndex: -1,
        regexError: null,
        skippedLongNodes: 0,
      })
      return
    }
    set({ container: el })
  },

  setRevealBlockId: (blockId) => {
    set({ revealBlockId: blockId })
  },

  setReplaceOpen: (replaceOpen) => {
    set({ replaceOpen })
  },

  setReplacement: (replacement) => {
    set({ replacement })
  },
}))
