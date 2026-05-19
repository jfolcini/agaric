/**
 * useCommandPaletteStore — Zustand singleton for the Cmd/Ctrl+K
 * command palette (PEND-61 Phases 2-4 — successor to
 * `useSearchPaletteStore`).
 *
 * Owns:
 *
 *  - `open` — whether the palette dialog is mounted.
 *  - `mode` — active palette mode. v1 ships `'search'` and `'commands'`;
 *    `'nav'` / `'spaces'` / `'agents'` / `'settings'` are reserved
 *    enum slots for future phases. The `>` input prefix opens
 *    `'commands'` mode; backspacing the prefix returns to `'search'`.
 *  - `query` — current input string. Cleared on every open.
 *  - `pendingViewQuery` — transient handoff slot consumed by
 *    `SearchPanel` on mount when the user activates the escalation
 *    footer (or the "Search in all pages" command). The view reads
 *    and clears this slot exactly once.
 *  - `previousFocusedElement` — the DOM element that had focus when
 *    Cmd+K opened, used as the insertion target for `[[page]]`
 *    autocomplete (Enter inserts the link into the previously focused
 *    block). Cleared on close.
 *
 * The cmdk shell consumes this state but holds its own internal
 * highlighted-item index — we no longer mirror keyboard nav in the
 * store. Match-collection / merge logic lives in `CommandPalette.tsx`.
 */

import { create } from 'zustand'

/**
 * Closed enum of palette modes. v1 ships `'search'` and `'commands'`;
 * the rest are reserved so callers can early-narrow on future
 * additions without re-wiring the type.
 */
export type PaletteMode = 'search' | 'commands' | 'nav' | 'spaces' | 'agents' | 'settings'

interface CommandPaletteState {
  /** Whether the palette dialog is mounted. */
  open: boolean
  /** Active mode. See `PaletteMode`. */
  mode: PaletteMode
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
   * insert a `[[Page Title]]` link via `[[page]]` autocomplete.
   * `null` when the palette was opened cold (no editor focus) — the
   * autocomplete mode degrades to plain page navigation in that case.
   */
  previousFocusedElement: HTMLElement | null

  /** Open the palette in search mode. Captures the current focused element. */
  open$: () => void
  /** Close the palette; clears `query`, `mode`, and `previousFocusedElement`. */
  close: () => void
  /** Set the input query string. */
  setQuery: (q: string) => void
  /** Switch palette mode without closing the dialog. */
  setMode: (mode: PaletteMode) => void
  /**
   * Escalate the current query to the find-in-files view: writes
   * `pendingViewQuery`, closes the palette, and (caller) flips the
   * navigation store to `'search'`.
   */
  setPendingViewQuery: (q: string | null) => void
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  mode: 'search',
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
    set({ open: true, mode: 'search', query: '', previousFocusedElement: focused })
  },

  close: () => {
    set({ open: false, mode: 'search', query: '', previousFocusedElement: null })
  },

  setQuery: (q) => {
    set({ query: q })
  },

  setMode: (mode) => {
    set({ mode })
  },

  setPendingViewQuery: (q) => {
    set({ pendingViewQuery: q })
  },
}))
