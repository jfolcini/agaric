/**
 * Mobile unified-search sheet: one touch Sheet in place of in-page find, the
 * palette and find-in-files, with `'in-page'` and `'all-pages'` segments.
 * `query` bridges the segments' own stores, so switching segment re-scopes the
 * same query; cleared on close.
 */

import { create } from 'zustand'

import type { View } from '@/stores/navigation'
import type { SearchSheetMode } from '@/types/search-sheet-mode'

// The mode type lives in `@/types/search-sheet-mode` so `lib/` can use it without importing `stores/`.
export type { SearchSheetMode } from '@/types/search-sheet-mode'

/** The default segment: in-page while reading a page (journal or editor), else all pages. */
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
