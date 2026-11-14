import { Pencil, Search } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import {
  QueryColumnPicker,
  type QueryColumnPickerProps,
} from '@/components/query/QueryColumnPicker'
import { QueryResultList } from '@/components/query/QueryResultList'
import { QueryResultTable } from '@/components/query/QueryResultTable'
import { useQueryTableColumns } from '@/components/query/use-query-table-columns'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { useQueryExecution } from '@/hooks/useQueryExecution'
import { useQuerySorting } from '@/hooks/useQuerySorting'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { PropertyRow } from '@/lib/bindings'
import { countFilterLeaves, decodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { buildCustomPropsMap } from '@/lib/query-result-columns'
import { chipTagId, isLegacyQueryText, readQueryText } from '@/lib/query-text'
import { OPERATOR_SYMBOLS, parseQueryExpression } from '@/lib/query-utils'
import { reportIpcError } from '@/lib/report-ipc-error'
import { type FilterToken, tokenKey, tokenSource } from '@/lib/search-query'
import { usePageBlockStoreOptional } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'

// #5441 — lazy: the builder loads when "edit query" is first used, not with every query block.
const QueryBuilderModal = lazy(() =>
  import('@/components/dialogs/QueryBuilderModal').then((m) => ({ default: m.QueryBuilderModal })),
)

/** The result blocks' properties: as stored, and as the display values the columns show. */
interface ResultProperties {
  rows: Record<string, PropertyRow[]>
  customProps: Map<string, Map<string, string>>
}

const NO_PROPERTIES: ResultProperties = { rows: {}, customProps: new Map() }

/** A tag chip's token (`#[ULID]`, a `#name` typed in the block) as the tag's name. */
function TagChipPill({ id }: { id: string }): React.ReactElement {
  const name = useResolveStore((s) => {
    const title = s.resolveTitle(id)
    return title.startsWith('[[') ? id : title
  })
  return <Badge tone="secondary">tag:#{name}</Badge>
}

function QueryTokenPill({ token }: { token: FilterToken }): React.ReactElement {
  const chip = token.kind === 'tag' ? chipTagId(token.value) : null
  if (chip !== null) return <TagChipPill id={chip} />
  return (
    <Badge tone={token.kind === 'invalid' ? 'destructive' : 'secondary'}>
      {tokenSource(token)}
    </Badge>
  )
}

/** A search-syntax query (#6628) as the search box's chips: one per token, then the free text. */
function QueryTextPills({ expression }: { expression: string }): React.ReactElement {
  const { ast } = readQueryText(expression)
  return (
    <span className="flex flex-1 flex-wrap items-center gap-1" title={expression}>
      {ast.filters.map((token) => (
        <QueryTokenPill key={tokenKey(token)} token={token} />
      ))}
      {ast.freeText !== '' && <Badge tone="secondary">{ast.freeText}</Badge>}
    </span>
  )
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
  if (!isLegacyQueryText(expression)) return <QueryTextPills expression={expression} />

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
    // The column list is the table's layout, not a filter (#6544).
    if (key === 'type' || key === 'columns') continue
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
    return <span className="flex-1 text-xs">{expression}</span>
  }

  return (
    <span className="flex flex-1 flex-wrap items-center gap-1" title={expression}>
      {pills}
    </span>
  )
}

/**
 * #3315 item 3 — a column sort in an inline query table is a `toSorted` over
 * `results` (`useQuerySorting`), which holds only the pages loaded so far,
 * while `useQueryExecution` pages at 50 with a Load-more button below the
 * table. "Click Priority to see the top task" therefore answers over the loaded
 * prefix: a P3 row can sit at the top while P0 rows wait in pages 2-4. Until
 * the sort is pushed into the query, say what the sort actually covers, next to
 * the existing partial-count label (`query.resultCountPartial`) in the header.
 *
 * Only rendered once a sort is applied — an unsorted partial table is already
 * labelled by that count. Extracted as its own component so the guard chain
 * does not add decision points to `QueryResult`'s cyclomatic complexity.
 */
function SortPartialNotice({
  loading,
  error,
  tableMode,
  hasMore,
  sortKey,
  loadedCount,
}: {
  loading: boolean
  error: string | null
  tableMode: boolean
  hasMore: boolean
  sortKey: string | null
  loadedCount: number
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (loading || error || !tableMode || !hasMore || sortKey == null) return null
  return (
    <output
      data-testid="query-sort-partial-notice"
      className="block px-3 pb-1 text-xs text-muted-foreground"
    >
      {t('query.sortPartialNotice', { count: loadedCount })}
    </output>
  )
}

/**
 * The column picker, for a table a block holds (#6544). A component of its own
 * so its guard adds no decision point to `QueryResult`, as `SortPartialNotice`.
 */
function ColumnPickerSlot({
  blockId,
  tableMode,
  ...picker
}: QueryColumnPickerProps & {
  blockId: string | undefined
  tableMode: boolean
}): React.ReactElement | null {
  if (!blockId || !tableMode) return null
  return <QueryColumnPicker {...picker} />
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
  /**
   * Write the expression the builder saved; resolves whether it did. The page
   * store's `edit` of `blockId` when absent. Page mode writes it in turn with
   * its saves (#5743).
   */
  onSave?: ((expression: string) => Promise<boolean>) | undefined
}

export function QueryResult({
  expression,
  blockId,
  onNavigate,
  resolveBlockTitle,
  onSave,
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
    resultsUpdatedAt,
    handleLoadMore,
    fetchResults,
  } = useQueryExecution({ expression })

  // A structured (`v2:`) query carries its table flag in the decoded spec; a
  // text query, older or search syntax, carries `table:true` as a word.
  const structured = decodeInlineQueryPayload(expression)
  const tableMode = structured
    ? structured.table
    : parseQueryExpression(expression).params['table'] === 'true'

  // Custom (non-reserved) properties are not carried on `BlockRow`; fetch them
  // for the result blocks only in table mode, where they become columns.
  const [{ rows: propertyRows, customProps }, setProperties] = useState(NO_PROPERTIES)
  useEffect(() => {
    if (!tableMode || results.length === 0) {
      setProperties(NO_PROPERTIES)
      return
    }
    let cancelled = false
    void commands
      .getBatchProperties(results.map((b) => b.id))
      .then(unwrap)
      .then((batch) => {
        if (!cancelled) setProperties({ rows: batch, customProps: buildCustomPropsMap(batch) })
      })
      .catch((err) => {
        // A property-fetch failure should not blank the table; fall back to
        // the fixed columns and surface the error to the IPC reporter.
        if (!cancelled) setProperties(NO_PROPERTIES)
        reportIpcError('QueryResult', 'queryBuilder.propertiesFailed', err, t, { blockId })
      })
    return () => {
      cancelled = true
    }
    // Keyed on every fetch, not on the result ids: a property change leaves the
    // ids alone (#5298). `results` moves with it; tableMode gates the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableMode, resultsUpdatedAt, t, blockId])

  const { sortedResults, sortKey, sortDir, handleColumnSort } = useQuerySorting({
    results,
    customProps,
  })

  // #2663 — the page store's `edit()` action (tolerant of no ambient
  // `PageBlockStoreProvider`, e.g. in isolated tests: falls back to a shared
  // empty store whose writes are inert). Selecting the action itself (not a
  // value) keeps this reference stable across renders.
  const editPageBlock = usePageBlockStoreOptional((s) => s.edit)

  const writeExpression = useCallback(
    (next: string): Promise<boolean> =>
      blockId
        ? (onSave?.(next) ?? editPageBlock(blockId, `{{query ${next}}}`))
        : Promise.resolve(false),
    [blockId, editPageBlock, onSave],
  )

  const { columns, picker } = useQueryTableColumns({
    expression,
    results,
    customProps,
    writeExpression,
  })

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
      const ok = await writeExpression(newExpression)
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
    [blockId, expression, fetchResults, writeExpression],
  )

  return (
    <div
      className="query-result my-1 rounded-lg border bg-muted/20 text-sm"
      data-testid="query-result"
    >
      {/* Header */}
      <div className="flex w-full items-center gap-0 text-xs font-medium text-muted-foreground">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors focus-ring-visible"
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
        <ColumnPickerSlot blockId={blockId} tableMode={tableMode} {...picker} />
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
            <Pencil />
          </Button>
        )}
      </div>

      {/* Results */}
      {!collapsed && (
        <div className="border-t">
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
              propertyRows={propertyRows}
              // #3315 item 3 — the sort is client-side over the loaded pages.
              partial={hasMore}
            />
          )}
          <SortPartialNotice
            loading={loading}
            error={error}
            tableMode={tableMode}
            hasMore={hasMore}
            sortKey={sortKey}
            loadedCount={results.length}
          />
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

      {blockId && builderOpen && (
        <Suspense fallback={null}>
          <QueryBuilderModal
            open={builderOpen}
            onOpenChange={setBuilderOpen}
            initialExpression={expression}
            onSave={handleBuilderSave}
          />
        </Suspense>
      )}
    </div>
  )
}
