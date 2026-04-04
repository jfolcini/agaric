import { ArrowDown, ArrowUp, ChevronDown, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BacklinkFilter, BlockRow } from '../lib/tauri'
import { batchResolve, listBlocks, queryByProperty, queryByTags } from '../lib/tauri'
import { cn } from '../lib/utils'

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

export interface QueryResultProps {
  /** The raw query expression, e.g. "type:tag expr:project" */
  expression: string
  /** Navigate to a block's parent page */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID */
  resolveBlockTitle?: ((id: string) => string) | undefined
}

/** Parsed property filter from shorthand syntax (property:key=value). */
export interface PropertyFilter {
  key: string
  value: string
}

/** Parse a query expression string into structured params.
 *
 * Supports both the legacy explicit-type syntax and the new shorthand:
 * - Legacy: `type:tag expr:project` or `type:property key:X value:Y`
 * - Shorthand: `property:key=value` and `tag:prefix`
 *
 * Multiple shorthand tokens are collected and produce a `'filtered'` type
 * with AND semantics.
 */
export function parseQueryExpression(expr: string): {
  type: 'tag' | 'property' | 'backlinks' | 'filtered' | 'unknown'
  params: Record<string, string>
  propertyFilters: PropertyFilter[]
  tagFilters: string[]
} {
  const parts = expr.trim().split(/\s+/)
  const params: Record<string, string> = {}
  const propertyFilters: PropertyFilter[] = []
  const tagFilters: string[] = []

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      const prefix = part.slice(0, colonIdx)
      const rest = part.slice(colonIdx + 1)

      if (prefix === 'property' && rest.includes('=')) {
        // Shorthand: property:key=value
        const eqIdx = rest.indexOf('=')
        propertyFilters.push({ key: rest.slice(0, eqIdx), value: rest.slice(eqIdx + 1) })
      } else if (prefix === 'tag' && rest !== '') {
        // Shorthand: tag:prefix
        tagFilters.push(rest)
      } else {
        params[prefix] = rest
      }
    }
  }

  // If shorthand filters were found, treat as a 'filtered' query
  if (propertyFilters.length > 0 || tagFilters.length > 0) {
    return { type: 'filtered', params, propertyFilters, tagFilters }
  }

  const explicitType = params.type as 'tag' | 'property' | 'backlinks' | undefined
  return { type: explicitType ?? 'unknown', params, propertyFilters, tagFilters }
}

/** Build BacklinkFilter objects from parsed shorthand filters.
 *
 * Maps known fixed-field keys (todo_state, priority, due_date) to their
 * specialised filter variants, and falls back to PropertyText for custom
 * property keys.  Tag filters become HasTagPrefix filters.
 */
export function buildFilters(
  propertyFilters: PropertyFilter[],
  tagFilters: string[],
): BacklinkFilter[] {
  const filters: BacklinkFilter[] = []

  for (const pf of propertyFilters) {
    if (pf.key === 'todo_state') {
      filters.push({ type: 'TodoState', state: pf.value })
    } else if (pf.key === 'priority') {
      filters.push({ type: 'Priority', level: pf.value })
    } else if (pf.key === 'due_date') {
      filters.push({ type: 'DueDate', op: 'Eq', value: pf.value })
    } else {
      filters.push({ type: 'PropertyText', key: pf.key, op: 'Eq', value: pf.value })
    }
  }

  for (const tf of tagFilters) {
    filters.push({ type: 'HasTagPrefix', prefix: tf })
  }

  return filters
}

/** Truncate content for display. */
function truncate(text: string | null, max = 80): string {
  if (!text) return '(empty)'
  const plain = text.replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}

export function QueryResult({
  expression,
  onNavigate,
  resolveBlockTitle,
}: QueryResultProps): React.ReactElement {
  const [results, setResults] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDirection>('asc')

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

  const fetchResults = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!expression.trim()) {
        setError('Query expression is empty')
        setLoading(false)
        return
      }
      const { type, params, propertyFilters, tagFilters } = parseQueryExpression(expression)
      let items: BlockRow[] = []

      if (type === 'tag') {
        const tagExpr = params.expr ?? ''
        const resp = await queryByTags({
          tagIds: [],
          prefixes: tagExpr ? [tagExpr] : [],
          mode: 'or',
          limit: 50,
        })
        items = resp.items
      } else if (type === 'property') {
        if (!params.key) {
          setError('Property query requires key:NAME parameter')
          setLoading(false)
          return
        }
        const resp = await queryByProperty({
          key: params.key,
          ...(params.value != null && { valueText: params.value }),
          ...(params.date != null && { valueDate: params.date }),
          limit: 50,
        })
        items = resp.items
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
          setLoading(false)
          return
        }
        const resp = await listBlocks({ parentId: params.target, limit: 50 })
        items = resp.items
      } else {
        setError(`Unknown query type: ${type}`)
        setLoading(false)
        return
      }

      setResults(items)

      // Resolve parent page titles
      const parentIds = items.map((b) => b.parent_id).filter((id): id is string => id != null)
      if (parentIds.length > 0) {
        const resolved = await batchResolve([...new Set(parentIds)])
        const titleMap = new Map<string, string>()
        for (const r of resolved) {
          if (r.title) titleMap.set(r.id, r.title)
        }
        setPageTitles(titleMap)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Query failed')
    } finally {
      setLoading(false)
    }
  }, [expression])

  useEffect(() => {
    fetchResults()
  }, [fetchResults])

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
        <Search size={12} className="shrink-0" />
        <code className="flex-1 font-mono text-[11px]">{expression}</code>
        <span className="shrink-0 tabular-nums">
          {loading ? '...' : `${results.length} result${results.length !== 1 ? 's' : ''}`}
        </span>
        <ChevronDown
          size={12}
          className={cn('shrink-0 transition-transform', collapsed && '-rotate-90')}
        />
      </button>

      {/* Results */}
      {!collapsed && (
        <div className="border-t border-dashed border-muted-foreground/20">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>}
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {!loading && !error && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">No results</div>
          )}
          {!loading && !error && results.length > 0 && !tableMode && (
            <ul className="divide-y divide-muted-foreground/10">
              {results.map((block) => {
                const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
                return (
                  <li key={block.id} className="query-result-item" data-testid="query-result-item">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (block.parent_id && onNavigate) {
                          onNavigate(block.parent_id)
                        }
                      }}
                    >
                      {block.todo_state && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none',
                            block.todo_state === 'DONE'
                              ? 'bg-status-done text-status-done-foreground'
                              : block.todo_state === 'DOING'
                                ? 'bg-status-active text-status-active-foreground'
                                : 'bg-status-pending text-status-pending-foreground',
                          )}
                        >
                          {block.todo_state}
                        </span>
                      )}
                      <span className="flex-1 truncate">
                        {resolveBlockTitle
                          ? resolveBlockTitle(block.id) || truncate(block.content)
                          : truncate(block.content)}
                      </span>
                      {pageTitle && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60 truncate max-w-[120px]">
                          {pageTitle}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {!loading && !error && results.length > 0 && tableMode && (
            <div className="overflow-x-auto">
              {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: table uses grid role for sortable column headers */}
              <table className="w-full text-xs" role="grid">
                <thead>
                  <tr className="border-b border-muted-foreground/20">
                    {columns.map((col) => (
                      <th
                        key={col.key}
                        className="px-3 py-1.5 text-left font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors"
                        onClick={() => handleColumnSort(col.key)}
                        aria-sort={
                          sortKey === col.key
                            ? sortDir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortKey === col.key &&
                            (sortDir === 'asc' ? (
                              <ArrowUp size={10} aria-hidden="true" />
                            ) : (
                              <ArrowDown size={10} aria-hidden="true" />
                            ))}
                        </span>
                      </th>
                    ))}
                    <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
                      Page
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-muted-foreground/10">
                  {sortedResults.map((block) => {
                    const pageTitle = block.parent_id ? pageTitles.get(block.parent_id) : undefined
                    return (
                      <tr key={block.id} className="hover:bg-muted/40 transition-colors">
                        {columns.map((col) => (
                          <td key={col.key} className="px-3 py-1.5">
                            {col.key === 'content' ? (
                              <button
                                type="button"
                                className="text-left hover:underline truncate max-w-[300px] block"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (block.parent_id && onNavigate) {
                                    onNavigate(block.parent_id)
                                  }
                                }}
                              >
                                {resolveBlockTitle
                                  ? resolveBlockTitle(block.id) || truncate(block.content)
                                  : truncate(block.content)}
                              </button>
                            ) : (
                              <span>{(block[col.key as keyof BlockRow] as string) ?? ''}</span>
                            )}
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-muted-foreground/60 truncate max-w-[120px]">
                          {pageTitle ?? ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
