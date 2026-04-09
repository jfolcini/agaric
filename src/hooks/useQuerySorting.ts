import { useCallback, useMemo, useState } from 'react'
import type { BlockRow } from '@/lib/tauri'

export type SortDirection = 'asc' | 'desc'

/** Compare two block values for sorting. */
export function compareValues(a: string | null, b: string | null, dir: SortDirection): number {
  if (a == null && b == null) return 0
  if (a == null) return dir === 'asc' ? 1 : -1
  if (b == null) return dir === 'asc' ? -1 : 1
  const cmp = a.localeCompare(b)
  return dir === 'asc' ? cmp : -cmp
}

interface UseQuerySortingOptions {
  results: BlockRow[]
}

interface UseQuerySortingResult {
  sortedResults: BlockRow[]
  sortKey: string | null
  sortDir: SortDirection
  handleColumnSort: (key: string) => void
}

export function useQuerySorting(options: UseQuerySortingOptions): UseQuerySortingResult {
  const { results } = options
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>('asc')

  const sortedResults = useMemo(() => {
    if (!sortKey) return results
    return [...results].sort((a, b) => {
      const aVal =
        sortKey === 'content' ? a.content : (a[sortKey as keyof BlockRow] as string | null)
      const bVal =
        sortKey === 'content' ? b.content : (b[sortKey as keyof BlockRow] as string | null)
      return compareValues(aVal ?? null, bVal ?? null, sortDir)
    })
  }, [results, sortKey, sortDir])

  const handleColumnSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return key
      }
      setSortDir('asc')
      return key
    })
  }, [])

  return { sortedResults, sortKey, sortDir, handleColumnSort }
}
