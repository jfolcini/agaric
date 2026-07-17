import { Pencil, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { QueryBuilderModal } from '@/components/dialogs/QueryBuilderModal'
import { QueryResultList } from '@/components/query/QueryResultList'
import type { TableColumn } from '@/components/query/QueryResultTable'
import { QueryResultTable } from '@/components/query/QueryResultTable'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { useQueryExecution } from '@/hooks/useQueryExecution'
import { useQuerySorting } from '@/hooks/useQuerySorting'
import { countFilterLeaves, decodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { buildCustomPropsMap, deriveCustomColumns } from '@/lib/query-result-columns'
import { OPERATOR_SYMBOLS, parseQueryExpression } from '@/lib/query-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import type { BlockRow } from '@/lib/tauri'
import { getBatchProperties } from '@/lib/tauri'
import { usePageBlockStoreOptional } from '@/stores/page-blocks'

/** Known block property keys that can become table columns. */
const KNOWN_PROPERTY_KEYS: { key: keyof BlockRow; label: string }[] = [
  { key: 'todo_state', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due_date', label: 'Due Date' },
  { key: 'scheduled_date', label: 'Scheduled' },
]

/** Build the table column set: the fixed Content + known-property columns,
 * followed by data-driven columns for any custom properties present on the
 * result blocks (sorted alphabetically). */
export function detectColumns(
  results: BlockRow[],
  customProps: Map<string, Map<string, string>>,
): TableColumn[] {
  return [
    { key: 'content', label: 'Content' },
    ...KNOWN_PROPERTY_KEYS,
    ...deriveCustomColumns(results, customProps),
  ]
}

/** Render query expression as styled filter pills. */
function QueryExpressionPills({ expression }: { expression: string }): React.ReactElement {
  const { t } = useTranslation()

  // A structured (`v2:`) query has an opaque base64 payload, so the legacy text
  // pills don't apply — show a single labelled badge with the condition count.
  const structured = decodeInlineQueryPayload(expression)
  if (structured) {
    return (
      <span className="flex flex-1 flex-wrap items-center gap-1">
        <Badge tone="default">
          {t('query.advancedQueryLabel', { count: countFilterLeaves(structured.filter) })}
        </Badge>
      </span>
    )
  }

  const parsed = parseQueryExpression(expression)
  const pills: React.ReactNode[] = []

  if (parsed.type !== 'unknown') {
    pills.push(
      <Badge key="type" tone="default">
        {parsed.type}
      </Badge>,
    )
  }

  for (const [key, value] of Object.entries(parsed.params)) {
    if (key === 'type') continue
    pills.push(
      <Badge key={`param-${key}`} tone="secondary">
        {key}: {value}
      </Badge>,
    )
  }

  // #1525 — derive each key from the filter's own data (key + operator + value)
  // and disambiguate true duplicates with a per-key occurrence counter, so
  // repeated property filters on the same key (e.g. a range `due>=X due<=Y`) or
  // identical filters do not collapse to the same React key — which triggers a
  // duplicate-key warning and risks mis-reconciliation. A data-derived counter
  // (rather than the bare array index) also satisfies react/no-array-index-key.
  const keySeen = new Map<string, number>()
  const uniqueKey = (base: string): string => {
    const seen = keySeen.get(base) ?? 0
    keySeen.set(base, seen + 1)
    return seen === 0 ? base : `${base}#${seen}`
  }

  for (const pf of parsed.propertyFilters) {
    const op = pf.operator ?? 'eq'
    const opSymbol = OPERATOR_SYMBOLS[op] ?? '='
    pills.push(
      <Badge key={uniqueKey(`prop-${pf.key}-${op}-${pf.value}`)} tone="secondary">
        {pf.key} {opSymbol} {pf.value}
      </Badge>,
    )
  }

  for (const tag of parsed.tagFilters) {
    pills.push(
      <Badge key={uniqueKey(`tag-${tag}`)} tone="secondary">
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

  // A structured (`v2:`) query carries its table flag in the decoded spec; a
  // legacy text query carries `table:true` as a parsed param.
  const structured = decodeInlineQueryPayload(expression)
  const tableMode = structured
    ? structured.table
    : parseQueryExpression(expression).params['table'] === 'true'

  // Custom (non-reserved) properties are not carried on `BlockRow`; fetch them
  // for the result blocks only in table mode, where they become columns.
  const [customProps, setCustomProps] = useState<Map<string, Map<string, string>>>(new Map())
  // Perf (#2041): memoize the joined result-id key so the O(n) map+join only
  // recomputes when `results` changes, not on every render.
  const resultIdsKey = useMemo(() => results.map((b) => b.id).join(','), [results])
  useEffect(() => {
    if (!tableMode || results.length === 0) {
      setCustomProps(new Map())
      return
    }
    let cancelled = false
    void getBatchProperties(results.map((b) => b.id))
      .then((batch) => {
        if (!cancelled) setCustomProps(buildCustomPropsMap(batch))
      })
      .catch((err) => {
        // A property-fetch failure should not blank the table; fall back to
        // the fixed columns and surface the error to the IPC reporter.
        if (!cancelled) setCustomProps(new Map())
        reportIpcError('QueryResult', 'queryBuilder.propertiesFailed', err, t, { blockId })
      })
    return () => {
      cancelled = true
    }
    // resultIdsKey captures the result-set identity; tableMode gates the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableMode, resultIdsKey, t, blockId])

  const { sortedResults, sortKey, sortDir, handleColumnSort } = useQuerySorting({
    results,
    customProps,
  })

  const columns = useMemo(() => detectColumns(results, customProps), [results, customProps])

  // #2663 — the page store's `edit()` action (tolerant of no ambient
  // `PageBlockStoreProvider`, e.g. in isolated tests: falls back to a shared
  // empty store whose writes are inert). Selecting the action itself (not a
  // value) keeps this reference stable across renders.
  const editPageBlock = usePageBlockStoreOptional((s) => s.edit)

  const handleBuilderSave = useCallback(
    async (newExpression: string) => {
      if (!blockId) return
      // Route through the page store's `edit()` — the same call
      // BlockTree's own builder save (`handleQuerySave`) makes — instead of
      // a raw `editBlock` IPC write. `edit()` owns BOTH halves of the
      // contract this widget was missing:
      //   1. It resets the undo store's redo stack via
      //      `notifyUndoNewAction` (mirrors the #2662 fix in BlockTree's
      //      `handleTurnInto`), which a raw IPC call never touched.
      //   2. It writes the new content into the page store that this
      //      component's `expression` prop is derived from upstream
      //      (StaticBlock → StaticQueryBlock). A raw IPC write left that
      //      prop — and this widget's rendered pills/results — on the OLD
      //      expression until an unrelated page reload, and a later
      //      focus+blur on the block could re-persist the stale content.
      // `edit()` also surfaces its own save-failed toast and rolls back
      // optimistic state on failure, so no separate try/catch is needed.
      // No unconditional manual `fetchResults()` call: `useQueryExecution`
      // embeds `expression` in its query key, so once the store's new
      // content flows back down as a fresh `expression` prop the query
      // refetches on its own — calling `fetchResults()` here would just
      // re-run the OLD expression from this closure before that prop
      // update lands.
      const ok = await editPageBlock(blockId, `{{query ${newExpression}}}`)
      if (!ok) return
      setBuilderOpen(false)
      // Edge case the prop-driven refetch above can't cover: if the saved
      // expression is textually IDENTICAL to what's already rendered (e.g.
      // the user opened the builder and hit Save without changing any
      // criteria), the page store still writes the same string, so the
      // `expression` prop's VALUE never changes, the `useQueryExecution`
      // query key stays the same, and (staleTime: Infinity) nothing
      // refetches — a save that should still refresh results silently does
      // nothing. Force one explicitly in that case only, using the CURRENT
      // `expression` (which by construction equals `newExpression` here),
      // so this can't reintroduce the stale-closure bug the unconditional
      // call above had.
      if (newExpression === expression) fetchResults()
    },
    [blockId, editPageBlock, expression, fetchResults],
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
            {loading
              ? '...'
              : // #1743 — when more pages remain unloaded, the loaded-so-far
                // count is not the true total; label it as partial so it is not
                // mistaken for the final count (cf. AdvancedQueryView total).
                hasMore
                ? t('query.resultCountPartial', { count: results.length })
                : t('query.resultCount', { count: results.length })}
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
            <div className="px-3 py-2">
              <LoadingSkeleton count={3} height="h-8" />
            </div>
          )}
          {error && (
            <div
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              <span>{error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={fetchResults}
                aria-label={t('action.retry')}
                disabled={loading || loadingMore}
                aria-busy={loading || loadingMore}
              >
                {t('action.retry')}
              </Button>
            </div>
          )}
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
              customProps={customProps}
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
