/**
 * Command palette (Cmd/Ctrl+K) state. The `>` prefix enters `'commands'`
 * mode and backspacing it returns to `'search'`. `previousFocusedElement` and
 * `previousSelectionRange` are where a `[[page]]` link is inserted and where
 * focus returns on close. cmdk keeps its own highlighted item; matching lives
 * in `CommandPalette.tsx`.
 */

import { create } from 'zustand'

/** Palette modes. `'nav'`, `'spaces'`, `'agents'` and `'settings'` are reserved for later. */
export type PaletteMode =
  | 'search'
  | 'commands'
  | 'tags'
  | 'help'
  | 'nav'
  | 'spaces'
  | 'agents'
  | 'settings'

/**
 * A query per mode, so toggling modes is not destructive: `setQuery` writes
 * the flat `query` and its mode's slot, `setMode` restores from the slot, and
 * `close()` resets them.
 */
type QueryByMode = Record<PaletteMode, string>

function emptyQueryByMode(): QueryByMode {
  return {
    search: '',
    commands: '',
    tags: '',
    help: '',
    nav: '',
    spaces: '',
    agents: '',
    settings: '',
  }
}

interface CommandPaletteState {
  /** Whether the palette dialog is mounted. */
  open: boolean
  /** Active mode. See `PaletteMode`. */
  mode: PaletteMode
  /** Current input string (mirrors `queryByMode[mode]`). */
  query: string
  /** Per-mode query memory; see `QueryByMode`. */
  queryByMode: QueryByMode
  /** Handoff slot for escalating to the search view, consumed by `SearchPanel` on mount. */
  pendingViewQuery: string | null
  /**
   * The element focused when the palette opened: where a `[[page]]` link goes
   * and where focus returns. `null` when opened cold; autocomplete then only
   * navigates.
   */
  previousFocusedElement: HTMLElement | null
  /**
   * The selection at open, cloned before focus moved into the palette, which
   * collapses it in some browsers. `null` without a live selection;
   * `insertPageLinkInto` then reads the input's `selectionStart`.
   */
  previousSelectionRange: Range | null

  /** Open the palette in search mode. Captures the current focused element. */
  open$: () => void
  /** Close the palette; clears `query`, `mode`, and `previousFocusedElement`. */
  close: () => void
  /** Set the input query string for the current mode. */
  setQuery: (q: string) => void
  /** Switch palette mode without closing the dialog; restores that mode's remembered query. */
  setMode: (mode: PaletteMode) => void
  /**
   * Switch to `next` with query `q`, clearing the old mode's slot: its prefix
   * character was a shortcut, and keeping it would loop the mode router.
   */
  enterModeWithQuery: (next: PaletteMode, q: string) => void
  /**
   * Write or clear the handoff slot; the caller shows `'search'`, closing the
   * palette when escalating from it.
   */
  setPendingViewQuery: (q: string | null) => void
}

export const useCommandPaletteStore = create<CommandPaletteState>((set, get) => ({
  open: false,
  mode: 'search',
  query: '',
  queryByMode: emptyQueryByMode(),
  pendingViewQuery: null,
  previousFocusedElement: null,
  previousSelectionRange: null,

  open$: () => {
    // `HTMLElement` so `.focus()` is callable; `<body>` means nothing was focused.
    const active = document.activeElement
    const focused = active instanceof HTMLElement && active !== document.body ? active : null
    // Cloned, so a later `selectionchange` cannot mutate it; `getSelection` can
    // be absent in DOM-light environments.
    let snapshotRange: Range | null = null
    try {
      const sel = typeof document.getSelection === 'function' ? document.getSelection() : null
      if (sel && sel.rangeCount > 0) {
        snapshotRange = sel.getRangeAt(0).cloneRange()
      }
    } catch {
      // A sandboxed or detached document can throw here.
      snapshotRange = null
    }
    set({
      open: true,
      mode: 'search',
      query: '',
      queryByMode: emptyQueryByMode(),
      previousFocusedElement: focused,
      previousSelectionRange: snapshotRange,
    })
  },

  close: () => {
    set({
      open: false,
      mode: 'search',
      query: '',
      queryByMode: emptyQueryByMode(),
      previousFocusedElement: null,
      previousSelectionRange: null,
    })
  },

  setQuery: (q) => {
    // So a later `setMode` round-trip restores it.
    const { mode, queryByMode } = get()
    set({ query: q, queryByMode: { ...queryByMode, [mode]: q } })
  },

  setMode: (mode) => {
    const { queryByMode } = get()
    set({ mode, query: queryByMode[mode] ?? '' })
  },

  enterModeWithQuery: (next, q) => {
    const { mode, queryByMode } = get()
    set({
      mode: next,
      query: q,
      queryByMode: { ...queryByMode, [mode]: '', [next]: q },
    })
  },

  setPendingViewQuery: (q) => {
    set({ pendingViewQuery: q })
  },
}))
