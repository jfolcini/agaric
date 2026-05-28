/**
 * useSearchSheetStore — Zustand singleton for the mobile unified-search
 * sheet.
 *
 * The touch-only entry point that collapses three desktop search
 * surfaces (Ctrl+F in-page find, Cmd+K palette, Ctrl+Shift+F
 * find-in-files) into a single Sheet with two segments: `'in-page'`
 * and `'all-pages'`.
 *
 * Owns:
 *  - `open` — whether the sheet is mounted.
 *  - `mode` — active segment.
 *  - `query` — bridge value mirrored from the active segment's own
 *    store. Carries across segment switches so users get one-tap
 *    re-scope; SearchSheet's lifecycle effect subscribes to each
 *    segment's query and writes back here. Cleared on full close.
 */

import { create } from 'zustand'

import type { View } from './navigation'

/** Active segment of the unified search sheet. */
export type SearchSheetMode = 'in-page' | 'all-pages'

/**
 * Context-aware default segment picker. The sheet opens to "In this
 * page" when the user is currently reading a page (Journal or
 * page-editor); everywhere else (Pages list, Trash, Settings, Search
 * results view, etc.) defaults to "Across all pages".
 *
 * Exported as a pure function so callers and tests can derive the
 * default without instantiating the store.
 */
export function defaultModeForView(view: View): SearchSheetMode {
  return view === 'journal' || view === 'page-editor' ? 'in-page' : 'all-pages'
}

interface SearchSheetState {
  open: boolean
  mode: SearchSheetMode
  query: string

  /** Open the sheet with the given default segment. Resets `query`. */
  open$: (defaultMode: SearchSheetMode) => void
  /** Close the sheet. Resets `query`; preserves `mode` for the next open. */
  close: () => void
  setMode: (mode: SearchSheetMode) => void
  setQuery: (q: string) => void
}

export const useSearchSheetStore = create<SearchSheetState>((set) => ({
  open: false,
  mode: 'in-page',
  query: '',

  open$: (defaultMode) => {
    set({ open: true, mode: defaultMode, query: '' })
  },
  close: () => {
    set({ open: false, query: '' })
  },
  setMode: (mode) => {
    set({ mode })
  },
  setQuery: (q) => {
    set({ query: q })
  },
}))
