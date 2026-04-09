import { Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Spinner } from '@/components/ui/spinner'
import { parseQueryExpression } from '../lib/query-utils'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, listBlocks, queryByProperty, queryByTags } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { QueryResultList } from './QueryResultList'
import { QueryResultTable } from './QueryResultTable'

export type { PropertyFilter } from '../lib/query-utils'
// Re-export extracted utilities so existing consumers don't break
export { buildFilters, parseQueryExpression } from '../lib/query-utils'

/** Column definition for table mode. */
interface TableColumn {
  key: string
  label: string
}

/** Known block property keys that can become table columns. */
const KNOWN_PROPERTY_KEYS: { key: keyof BlockRow; label: string }[] = [
  { key: 'todo_state', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due_date', label: 'Due Date' },
  { key: 'scheduled_date', label: 'Scheduled' },
]

/** Number of items per paginated request. */
const PAGE_SIZE = 50

/** Auto-detect which columns to show based on result data. */
export function detectColumns(results: BlockRow[]): TableColumn[] {
  const cols: TableColumn[] = [{ key: 'content', label: 'Content' }]
  for (const { key, label } of KNOWN_PROPERTY_KEYS) {
    if (results.some((b) => b[key] != null && b[key] !== '')) {
      cols.push({ key, label })
    }
  }
  return cols
}

export type SortDirection = 'asc' | 'desc'

/** Compare two block values for sorting. */
function compareValues(a: string | null, b: string | null, dir: SortDirection): number {
  if (a == null && b == null) return 0
  if (a == null) return dir === 'asc' ? 1 : -1
  if (b == null) return dir === 'asc' ? -1 : 1
  const cmp = a.localeCompare(b)
  return dir === 'asc' ? cmp : -cmp
}

/** Render query expression as styled filter pills. */
function QueryExpressionPills({ expression }: { expression: string }): React.ReactElement {
  const parsed = parseQueryExpression(expression)
  const pills: React.ReactNode[] = []

  if (parsed.type !== 'unknown') {
    pills.push(
      <Badge key="type" variant="default">
        {parsed.type}
      </Badge>,
    )
  }

  for (const [key, value] of Object.entries(parsed.params)) {
    if (key === 'type') continue
    pills.push(
      <Badge key={`param-${key}`} variant="secondary">
        {key}: {value}
      </Badge>,
    )
  }

  for (const pf of parsed.propertyFilters) {
    pills.push(
      <Badge key={`prop-${pf.key}`} variant="secondary">
        {pf.key}={pf.value}
      </Badge>,
    )
  }

  for (const tag of parsed.tagFilters) {
    pills.push(
      <Badge key={`tag-${tag}`} variant="secondary">
        tag: {tag}
      </Badge>,
    )
  }

  if (pills.length === 0) {
    return <span className="flex-1 text-[11px]">{expression}</span>
  }

  return (
    <span className="flex flex-1 flex-wrap items-center gap-1" title={expression}>
      {pills}
    </span>
  )
}

export interface QueryResultProps {
  /** The raw query expression, e.g. "type:tag expr:project" */
  expression: string
  /** Navigate to a block's parent page */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID */
  resolveBlockTitle?: ((id: string) => string) | undefined
}

export function QueryResult({
  expression,
  onNavigate,
  resolveBlockTitle,
}: QueryResultProps): React.ReactElement {
  const { t } = useTranslation()
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>('asc')
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const { params } = parseQueryExpression(expression)
  const tableMode = params.table === 'true'

  const columns = useMemo(() => detectColumns(results), [results])

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
            queryPromises.push(
              queryByProperty({
                key: pf.key,
                valueText: pf.value,
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

  return (
    <div
      className="query-result my-1 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 text-sm"
      data-testid="query-result"
    >
      {/* Header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          setCollapsed(!collapsed)
        }}
      >
        <Search className="h-3 w-3 shrink-0" />
        <QueryExpressionPills expression={expression} />
        <span className="shrink-0 tabular-nums">
          {loading ? '...' : `${results.length} result${results.length !== 1 ? 's' : ''}`}
        </span>
        <ChevronToggle isExpanded={!collapsed} />
      </button>

      {/* Results */}
      {!collapsed && (
        <div className="border-t border-dashed border-muted-foreground/20">
          {loading && (
            <div className="flex justify-center px-3 py-2">
              <Spinner size="sm" />
            </div>
          )}
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {!loading && !error && results.length === 0 && (
            <EmptyState message={t('query.noResults')} compact />
          )}
          {!loading && !error && results.length > 0 && !tableMode && (
            <QueryResultList
              results={results}
              pageTitles={pageTitles}
              onNavigate={onNavigate}
              resolveBlockTitle={resolveBlockTitle}
            />
          )}
          {!loading && !error && results.length > 0 && tableMode && (
            <QueryResultTable
              results={sortedResults}
              columns={columns}
              pageTitles={pageTitles}
              sortKey={sortKey}
              sortDir={sortDir}
              onColumnSort={handleColumnSort}
              onNavigate={onNavigate}
              resolveBlockTitle={resolveBlockTitle}
            />
          )}
          {!loading && !error && (
            <LoadMoreButton
              hasMore={hasMore}
              loading={loadingMore}
              onLoadMore={handleLoadMore}
              className="mx-3 my-2"
            />
          )}
        </div>
      )}
    </div>
  )
}
