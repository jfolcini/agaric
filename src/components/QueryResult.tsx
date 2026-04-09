import { Pencil, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Spinner } from '@/components/ui/spinner'
import { useQueryExecution } from '../hooks/useQueryExecution'
import { useQuerySorting } from '../hooks/useQuerySorting'
import { OPERATOR_SYMBOLS, parseQueryExpression } from '../lib/query-utils'
import type { BlockRow } from '../lib/tauri'
import { editBlock } from '../lib/tauri'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { QueryBuilderModal } from './QueryBuilderModal'
import { QueryResultList } from './QueryResultList'
import { QueryResultTable } from './QueryResultTable'

export type { SortDirection } from '../hooks/useQuerySorting'
// Re-export sorting utilities for backward compat
export { compareValues } from '../hooks/useQuerySorting'
export type { PropertyFilter } from '../lib/query-utils'
// Re-export extracted utilities so existing consumers don't break
export { buildFilters, OPERATOR_SYMBOLS, parseQueryExpression } from '../lib/query-utils'

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
    const opSymbol = OPERATOR_SYMBOLS[pf.operator ?? 'eq'] ?? '='
    pills.push(
      <Badge key={`prop-${pf.key}`} variant="secondary">
        {pf.key} {opSymbol} {pf.value}
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
  /** When provided, enables the "Edit Query" button that opens the visual builder. */
  blockId?: string | undefined
  /** Navigate to a block's parent page */
  onNavigate?: ((pageId: string) => void) | undefined
  /** Resolve block title by ID */
  resolveBlockTitle?: ((id: string) => string) | undefined
}

export function QueryResult({
  expression,
  blockId,
  onNavigate,
  resolveBlockTitle,
}: QueryResultProps): React.ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)

  const {
    results,
    loading,
    error,
    hasMore,
    loadingMore,
    pageTitles,
    handleLoadMore,
    fetchResults,
  } = useQueryExecution({ expression })
  const { sortedResults, sortKey, sortDir, handleColumnSort } = useQuerySorting({ results })

  const { params } = parseQueryExpression(expression)
  const tableMode = params.table === 'true'

  const columns = useMemo(() => detectColumns(results), [results])

  const handleBuilderSave = useCallback(
    async (newExpression: string) => {
      if (!blockId) return
      try {
        await editBlock(blockId, `{{query ${newExpression}}}`)
        setBuilderOpen(false)
        fetchResults()
      } catch {
        toast.error(t('queryBuilder.saveFailed'))
      }
    },
    [blockId, fetchResults, t],
  )

  return (
    <div
      className="query-result my-1 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 text-sm"
      data-testid="query-result"
    >
      {/* Header */}
      <div className="flex w-full items-center gap-0 text-xs font-medium text-muted-foreground">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
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
        {blockId && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-1.5"
            onClick={(e) => {
              e.stopPropagation()
              setBuilderOpen(true)
            }}
            aria-label={t('queryBuilder.editButton')}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
      </div>

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

      {blockId && (
        <QueryBuilderModal
          open={builderOpen}
          onOpenChange={setBuilderOpen}
          initialExpression={expression}
          onSave={handleBuilderSave}
        />
      )}
    </div>
  )
}
