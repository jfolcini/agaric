/**
 * usePageBrowserSort — owns the `sort-by` preference for `PageBrowser`
 * (localStorage-backed via `useLocalStoragePreference`) and exposes the
 * `sortPages` callback that produces a comparator-applied copy of an
 * input page list. The comparator is shared by both the `Starred` and
 * `Pages` sections so they stay in lock-step under any sort option.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
 */

import { useCallback } from 'react'
import { getRecentPages } from '@/lib/recent-pages'
import type { BlockRow } from '../lib/tauri'
import { useLocalStoragePreference } from './useLocalStoragePreference'

export type SortOption = 'alphabetical' | 'recent' | 'created'

const SORT_STORAGE_KEY = 'page-browser-sort'
const DEFAULT_SORT: SortOption = 'alphabetical'

/**
 * Legacy storage format is the bare option string (e.g. `alphabetical`),
 * not JSON-encoded. Match that by parsing/serialising the bare value
 * with an allowlist guard so anything outside the three known options
 * falls back to the default.
 */
function parseSort(raw: string): SortOption {
  if (raw === 'alphabetical' || raw === 'recent' || raw === 'created') return raw
  throw new Error(`invalid sort option: ${raw}`)
}

function serializeSort(value: SortOption): string {
  return value
}

export interface UsePageBrowserSortReturn {
  sortOption: SortOption
  setSortOption: (value: SortOption) => void
  /** Apply the active comparator to `input`, returning a new array. */
  sortPages: (input: BlockRow[]) => BlockRow[]
}

export function usePageBrowserSort(): UsePageBrowserSortReturn {
  const [sortOption, setSortOptionRaw] = useLocalStoragePreference<SortOption>(
    SORT_STORAGE_KEY,
    DEFAULT_SORT,
    {
      parse: parseSort,
      serialize: serializeSort,
      source: 'usePageBrowserSort',
    },
  )

  const setSortOption = useCallback(
    (value: SortOption) => {
      setSortOptionRaw(value)
    },
    [setSortOptionRaw],
  )

  /**
   * Sort an array of pages in place by the active sort option.
   * Same comparator the legacy single-list sort used — extracted so we
   * can apply it independently inside the starred / other groups.
   */
  const sortPages = useCallback(
    (input: BlockRow[]): BlockRow[] => {
      const sorted = [...input]
      if (sortOption === 'alphabetical') {
        sorted.sort((a, b) => (a.content ?? '').localeCompare(b.content ?? ''))
      } else if (sortOption === 'created') {
        sorted.sort((a, b) => b.id.localeCompare(a.id))
      } else if (sortOption === 'recent') {
        const recentPages = getRecentPages()
        const recentMap = new Map(recentPages.map((rp) => [rp.id, rp.visitedAt]))
        sorted.sort((a, b) => {
          const aTime = recentMap.get(a.id)
          const bTime = recentMap.get(b.id)
          if (aTime && bTime) return bTime.localeCompare(aTime)
          if (aTime) return -1
          if (bTime) return 1
          return (a.content ?? '').localeCompare(b.content ?? '')
        })
      }
      return sorted
    },
    [sortOption],
  )

  return { sortOption, setSortOption, sortPages }
}
