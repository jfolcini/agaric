/**
 * usePageBrowserSort — owns the `sort-by` preference for `PageBrowser`
 * (localStorage-backed via `useLocalStoragePreference`).
 *
 * Every option is a server sort (#5371): `list_pages_with_metadata` orders all
 * pages in the space behind a keyset cursor, and the rows render in the order
 * they arrive. Nothing is re-sorted client-side.
 */

import { useCallback } from 'react'

import type { PageSort } from '@/lib/bindings'
import { PREFERENCES, type SortOption, usePreference } from '@/lib/preferences'

/**
 * The type is defined in the preferences registry (it annotates
 * `PREFERENCES.sort`) and re-exported here so this hook's public API is
 * unchanged. Owning it there keeps the import graph acyclic — the
 * import-cycle guard counts `import type` edges too.
 */
export type { SortOption }

/** The wire `PageSort` for an option: `recent` ("Last opened") is `last-opened`. */
export function pageSortWireFor(sort: SortOption): PageSort {
  return sort === 'recent' ? 'last-opened' : sort
}

export interface UsePageBrowserSortReturn {
  sortOption: SortOption
  setSortOption: (value: SortOption) => void
}

export function usePageBrowserSort(): UsePageBrowserSortReturn {
  const [sortOption, setSortOptionRaw] = usePreference(PREFERENCES.sort)

  const setSortOption = useCallback(
    (value: SortOption) => {
      setSortOptionRaw(value)
    },
    [setSortOptionRaw],
  )

  return { sortOption, setSortOption }
}
