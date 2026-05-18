/**
 * useSearchPaletteStore — Zustand singleton for the Cmd/Ctrl+K palette (PEND-51).
 *
 * Owns:
 *
 *  - `open` — whether the palette dialog is mounted.
 *  - `query` — current input string. Cleared on every open.
 *  - `pendingViewQuery` — transient handoff slot consumed by
 *    `SearchPanel` on mount when the user clicks the escalation footer
 *    (see plan §"Escalation to the find-in-files view"). The view
 *    reads and clears this slot exactly once; no global query state.
 *  - `previousFocusedElement` — the DOM element that had focus when
 *    Cmd+K opened, used as the insertion target for `[[page]]`
 *    autocomplete (per plan: "`[[page]]` autocomplete" — Enter inserts
 *    the link into the previously focused block). Cleared on close.
 *
 * Match-collection / merge logic lives in `SearchPalette.tsx` — the
 * store stays pure (no DOM access beyond capturing the focused element
 * on open). Pattern mirrors `useInPageFindStore` (PEND-52).
 */

import { create } from 'zustand'

interface SearchPaletteState {
  /** Whether the palette dialog is mounted. */
  open: boolean
  /** Current input string. */
  query: string
  /**
   * Transient handoff slot powering escalation to the find-in-files
   * view. Written by the palette on escalation; consumed by
   * `SearchPanel` on mount via `useEffect`.
   */
  pendingViewQuery: string | null
  /**
   * DOM element that had focus when the palette opened. Used to
   * insert a `[[Page Title]]` link via `[[page]]` autocomplete. `null`
   * when the palette was opened cold (no editor focus) — the autocomplete
   * mode is disabled in that case (plan §"`[[page]]` autocomplete
   * trigger" — "Requires a previously-focused block context").
   */
  previousFocusedElement: HTMLElement | null

  /** Open the palette. Captures the element that has focus right now. */
  open$: () => void
  /** Close the palette; clears `query` and `previousFocusedElement`. */
  close: () => void
  /** Set the input query string. */
  setQuery: (q: string) => void
  /**
   * Escalate the current query to the find-in-files view: writes
   * `pendingViewQuery`, closes the palette, and flips the navigation
   * store to the search view. The view's `useEffect` reads the slot
   * and clears it on mount.
   */
  setPendingViewQuery: (q: string | null) => void
}

export const useSearchPaletteStore = create<SearchPaletteState>((set) => ({
  open: false,
  query: '',
  pendingViewQuery: null,
  previousFocusedElement: null,

  open$: () => {
    // Capture the previously focused element so `[[page]]` autocomplete
    // can insert into it. Scope to `HTMLElement` (not `Element`) so
    // `.focus()` is callable; `document.activeElement` may return
    // `null` or the `<body>` when nothing is focused.
    const active = document.activeElement
    const focused = active instanceof HTMLElement && active !== document.body ? active : null
    set({ open: true, query: '', previousFocusedElement: focused })
  },

  close: () => {
    set({ open: false, query: '', previousFocusedElement: null })
  },

  setQuery: (q) => {
    set({ query: q })
  },

  setPendingViewQuery: (q) => {
    set({ pendingViewQuery: q })
  },
}))
