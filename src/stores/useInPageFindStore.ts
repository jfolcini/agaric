/**
 * useInPageFindStore — Zustand singleton for the in-page find toolbar (PEND-52).
 *
 * Owns:
 *
 *  - `open` — whether the toolbar is mounted.
 *  - `query` — current find string. Empty string ⇒ no matches.
 *  - `toggles` — `caseSensitive` / `wholeWord` / `isRegex`.
 *  - `totalMatches` / `currentIndex` — counter state, updated by the
 *    matcher driver (`InPageFind.tsx`'s effect) after each walk.
 *  - `regexError` — non-null when regex compilation fails; surfaced as
 *    an inline error on the input.
 *  - `skippedLongNodes` — count of >10 KB text nodes skipped during the
 *    last regex walk. Drives the "some long passages skipped" notice.
 *  - `containerRef` — registered by the active page wrapper
 *    (`PageEditor` / `JournalPage`) so the matcher knows which subtree
 *    to walk. Setting this to `null` (on view unmount) auto-closes
 *    the toolbar — there's nothing to search.
 *  - `lastQuery` — preserved across `close()` so re-opening the toolbar
 *    (with no selection) restores the previous query. Locked-in
 *    behaviour from the PEND-52 plan, Q3.
 *
 * Match collection itself lives in `InPageFind.tsx` — the store stays
 * pure (no DOM access, no side effects). This keeps unit tests simple
 * and matches the pattern of every other zustand store in `src/stores/`.
 */

import { create } from 'zustand'

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
  /** Inline error message when regex compilation fails. */
  regexError: string | null
  /** Count of >10 KB text nodes skipped during the last regex walk. */
  skippedLongNodes: number
  /** Page subtree to search. Registered by JournalPage / PageEditor. */
  container: HTMLElement | null
  /** Most-recent non-empty query — used to restore on re-open with no selection. */
  lastQuery: string

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
    regexError: string | null
    skippedLongNodes: number
  }) => void
  /** Move to the next match (wraps). */
  next: () => void
  /** Move to the previous match (wraps). */
  previous: () => void
  /** Register the host container (call with `null` to unregister). */
  setContainer: (el: HTMLElement | null) => void
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

  open$: (selection) => {
    const state = get()
    // Locked-in (Q3): selection becomes the initial query; otherwise
    // restore the previous query (browser/VSCode behaviour).
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
      // Reset counters; the InPageFind effect re-runs and re-fills them.
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
      // Clear visible state — the highlighter is cleared by the InPageFind
      // effect's cleanup. Keep `query` intact so a quick close/open round
      // trip without typing also restores cleanly via lastQuery.
      totalMatches: 0,
      currentIndex: -1,
      regexError: null,
      skippedLongNodes: 0,
    })
  },

  setQuery: (q) => {
    // Clearing the query resets the counter immediately so the toolbar
    // doesn't briefly show stale "3 of 12" before the walker re-runs.
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
    // Container unmounted (view switch) while the toolbar was open. Close it
    // — there's no surface to search against, and the overlay would otherwise
    // float disconnected from any content. Both changes are applied in a
    // single set() so the unmount-while-open path emits one notification.
    if (el === null && wasOpen) {
      set({
        container: el,
        open: false,
        totalMatches: 0,
        currentIndex: -1,
        regexError: null,
        skippedLongNodes: 0,
      })
      return
    }
    set({ container: el })
  },
}))
