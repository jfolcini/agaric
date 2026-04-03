import { ChevronDown, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, listBlocks, queryByProperty, queryByTags } from '../lib/tauri'
import { cn } from '../lib/utils'

export interface QueryResultProps {
  /** The raw query expression, e.g. "type:tag expr:project" */
  expression: string
  /** Navigate to a block's parent page */
  onNavigate?: (pageId: string) => void
  /** Resolve block title by ID */
  resolveBlockTitle?: (id: string) => string
}

/** Parse a query expression string into structured params. */
export function parseQueryExpression(expr: string): {
  type: 'tag' | 'property' | 'backlinks' | 'unknown'
  params: Record<string, string>
} {
  const parts = expr.trim().split(/\s+/)
  const params: Record<string, string> = {}
  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      params[part.slice(0, colonIdx)] = part.slice(colonIdx + 1)
    }
  }
  const type = params.type as 'tag' | 'property' | 'backlinks' | undefined
  return { type: type ?? 'unknown', params }
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

  const fetchResults = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { type, params } = parseQueryExpression(expression)
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
        const resp = await queryByProperty({
          key: params.key ?? '',
          valueText: params.value ?? undefined,
          valueDate: params.date ?? undefined,
          limit: 50,
        })
        items = resp.items
      } else if (type === 'backlinks') {
        const resp = await listBlocks({ parentId: params.target, limit: 50 })
        items = resp.items
      } else {
        setError(`Unknown query type: ${type}`)
        setLoading(false)
        return
      }

      setResults(items)

      // Resolve parent page titles
      const parentIds = items
        .map((b) => b.parent_id)
        .filter((id): id is string => id != null)
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
    <div className="query-result my-1 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 text-sm">
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
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>
          )}
          {error && (
            <div className="px-3 py-2 text-xs text-destructive">{error}</div>
          )}
          {!loading && !error && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">No results</div>
          )}
          {!loading && !error && results.length > 0 && (
            <ul className="divide-y divide-muted-foreground/10">
              {results.map((block) => {
                const pageTitle = block.parent_id
                  ? pageTitles.get(block.parent_id)
                  : undefined
                return (
                  <li key={block.id} className="query-result-item">
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
                            'shrink-0 rounded px-1 py-0.5 text-[10px] font-bold leading-none',
                            block.todo_state === 'DONE'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                              : block.todo_state === 'DOING'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                                : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
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
        </div>
      )}
    </div>
  )
}
