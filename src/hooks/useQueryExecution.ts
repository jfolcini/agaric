import { useCallback, useEffect, useState } from 'react'
import { parseDate } from '@/lib/parse-date'
import { parseQueryExpression } from '@/lib/query-utils'
import type { BlockRow } from '@/lib/tauri'
import { batchResolve, listBlocks, queryByProperty, queryByTags } from '@/lib/tauri'

/** Number of items per paginated request. */
const PAGE_SIZE = 50

interface UseQueryExecutionOptions {
  expression: string
}

interface UseQueryExecutionResult {
  results: BlockRow[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  pageTitles: Map<string, string>
  handleLoadMore: () => void
  fetchResults: () => void
}

export function useQueryExecution(options: UseQueryExecutionOptions): UseQueryExecutionResult {
  const { expression } = options
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const fetchResults = useCallback(
    async (pageCursor?: string) => {
      const isLoadMore = !!pageCursor
      if (isLoadMore) {
        setLoadingMore(true)
      } else {
        setLoading(true)
        setCursor(null)
        setHasMore(false)
      }
      setError(null)
      try {
        if (!expression.trim()) {
          setError('Query expression is empty')
          return
        }
        const { type, params, propertyFilters, tagFilters } = parseQueryExpression(expression)
        let items: BlockRow[] = []
        let nextCursor: string | null = null
        let responseHasMore = false

        if (type === 'tag') {
          const tagExpr = params.expr ?? ''
          const resp = await queryByTags({
            tagIds: [],
            prefixes: tagExpr ? [tagExpr] : [],
            mode: 'or',
            cursor: pageCursor,
            limit: PAGE_SIZE,
          })
          items = resp.items
          nextCursor = resp.next_cursor
          responseHasMore = resp.has_more
        } else if (type === 'property') {
          if (!params.key) {
            setError('Property query requires key:NAME parameter')
            return
          }
          const resp = await queryByProperty({
            key: params.key,
            ...(params.value != null && { valueText: params.value }),
            ...(params.date != null && { valueDate: params.date }),
            cursor: pageCursor,
            limit: PAGE_SIZE,
          })
          items = resp.items
          nextCursor = resp.next_cursor
          responseHasMore = resp.has_more
        } else if (type === 'filtered') {
          // Multi-filter query: execute individual queries in parallel,
          // then AND-intersect result sets client-side.
          const queryPromises: Promise<BlockRow[]>[] = []

          for (const pf of propertyFilters) {
            const resolvedDate = parseDate(pf.value)
            const op = pf.operator ?? 'eq'
            queryPromises.push(
              queryByProperty({
                key: pf.key,
                ...(resolvedDate ? { valueDate: resolvedDate } : { valueText: pf.value }),
                operator: op,
                limit: 200,
              }).then((resp) => resp.items),
            )
          }

          for (const tf of tagFilters) {
            queryPromises.push(
              queryByTags({
                tagIds: [],
                prefixes: [tf],
                mode: 'or',
                limit: 200,
              }).then((resp) => resp.items),
            )
          }

          const resultSets = await Promise.all(queryPromises)

          if (resultSets.length === 0) {
            items = []
          } else if (resultSets.length === 1) {
            items = resultSets[0] as BlockRow[]
          } else {
            // AND intersection: keep only blocks present in ALL result sets
            const blockMap = new Map<string, BlockRow>()
            for (const rs of resultSets) {
              for (const b of rs) {
                if (!blockMap.has(b.id)) blockMap.set(b.id, b)
              }
            }

            const idSets = resultSets.map((rs) => new Set(rs.map((b) => b.id)))
            const intersectedIds = idSets.reduce((acc, set) => {
              const result = new Set<string>()
              for (const id of acc) {
                if (set.has(id)) result.add(id)
              }
              return result
            })

            items = [...intersectedIds]
              .map((id) => blockMap.get(id))
              .filter((b): b is BlockRow => b != null)
              .slice(0, 50)
          }
        } else if (type === 'backlinks') {
          if (!params.target) {
            setError('Backlinks query requires target:ULID parameter')
            return
          }
          const resp = await listBlocks({
            parentId: params.target,
            cursor: pageCursor,
            limit: PAGE_SIZE,
          })
          items = resp.items
          nextCursor = resp.next_cursor
          responseHasMore = resp.has_more
        } else {
          setError(`Unknown query type: ${type}`)
          return
        }

        if (isLoadMore) {
          setResults((prev) => [...prev, ...items])
        } else {
          setResults(items)
        }
        setCursor(nextCursor)
        setHasMore(responseHasMore)

        // Resolve parent page titles
        const parentIds = items.map((b) => b.parent_id).filter((id): id is string => id != null)
        if (parentIds.length > 0) {
          const resolved = await batchResolve([...new Set(parentIds)])
          if (isLoadMore) {
            setPageTitles((prev) => {
              const updated = new Map(prev)
              for (const r of resolved) {
                if (r.title) updated.set(r.id, r.title)
              }
              return updated
            })
          } else {
            const titleMap = new Map<string, string>()
            for (const r of resolved) {
              if (r.title) titleMap.set(r.id, r.title)
            }
            setPageTitles(titleMap)
          }
        }
      } catch (e) {
        if (!isLoadMore) {
          setError(e instanceof Error ? e.message : 'Query failed')
        }
      } finally {
        if (isLoadMore) {
          setLoadingMore(false)
        } else {
          setLoading(false)
        }
      }
    },
    [expression],
  )

  useEffect(() => {
    fetchResults()
  }, [fetchResults])

  const handleLoadMore = useCallback(() => {
    if (cursor && !loadingMore) {
      fetchResults(cursor)
    }
  }, [cursor, loadingMore, fetchResults])

  return {
    results,
    loading,
    error,
    hasMore,
    loadingMore,
    pageTitles,
    handleLoadMore,
    fetchResults,
  }
}
