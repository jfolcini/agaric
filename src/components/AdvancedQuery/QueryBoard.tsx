/**
 * QueryBoard — an advanced query's results as a board (#6542): one column per
 * value of the group key (`boardColumns`), read-only.
 *
 * Each column runs the query's own filter AND-ed with its value through
 * `useAdvancedQuery`, so a column pages by cursor on its own, keeps the query's
 * sort, full-text term and summaries, and a value no block has is an empty
 * column rather than a missing one.
 */

import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { AggregateSummary } from '@/components/AdvancedQuery/AggregateSummary'
import type { BoardColumn } from '@/components/AdvancedQuery/board-columns'
import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { QueryResultList } from '@/components/query/QueryResultList'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import type { AggregateSpec, FilterExpr, SortKey } from '@/lib/bindings'
import { cn } from '@/lib/utils'

/** What every column of one board shares: the query, minus the column's value. */
interface BoardQuery {
  filter: FilterExpr
  fulltext: string
  sort: SortKey[]
  aggregates: AggregateSpec[]
  onNavigate?: ((pageId: string, title?: string) => void) | undefined
}

export interface QueryBoardProps extends BoardQuery {
  columns: BoardColumn[]
}

function QueryBoardColumn({
  column,
  filter,
  fulltext,
  sort,
  aggregates,
  onNavigate,
}: BoardQuery & { column: BoardColumn }): React.ReactElement | null {
  const { t } = useTranslation()
  const filterExpr = useMemo<FilterExpr>(
    () => ({ type: 'And', children: [filter, column.filter] }),
    [filter, column.filter],
  )
  const {
    results,
    aggregates: aggregateResults,
    loading,
    error,
    hasMore,
    loadingMore,
    totalCount,
    pageTitles,
    handleLoadMore,
    fetchResults,
  } = useAdvancedQuery({ filters: [], filterExpr, fulltext, sort, aggregates })

  const label =
    column.kind === 'value'
      ? (column.value ?? '')
      : t(column.kind === 'none' ? 'advancedQuery.board.noValue' : 'advancedQuery.board.other')
  const isEmpty = results.length === 0

  // Values outside the options are the exception; no column for none of them.
  if (column.kind === 'other' && isEmpty && !error) return null

  return (
    <section
      className="flex w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-lg bg-muted/50 p-2"
      aria-label={label}
      data-testid="query-board-column"
    >
      <header className="flex flex-wrap items-center gap-2 px-1">
        <h3 className="text-sm font-medium">{label}</h3>
        {totalCount != null && (
          <span className="text-xs text-muted-foreground" data-testid="query-board-column-count">
            {totalCount}
          </span>
        )}
        {aggregateResults != null && aggregateResults.length > 0 && (
          <AggregateSummary
            results={aggregateResults}
            specs={aggregates}
            label={t('advancedQuery.aggregate.summaryLabel')}
          />
        )}
      </header>

      {loading && isEmpty && (
        <LoadingSkeleton count={3} height="h-11" ariaLabel={t('advancedQuery.searching')} />
      )}

      {!loading && error && (
        <div className="flex flex-col items-start gap-2 px-1 text-xs text-destructive" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={fetchResults}>
            {t('action.retry')}
          </Button>
        </div>
      )}

      {!loading && !error && isEmpty && (
        // The message names the column: each EmptyState is a labelled region, and
        // several empty columns would otherwise share one name.
        <EmptyState
          message={t('advancedQuery.board.emptyColumn', { column: label })}
          compact
          headingLevel="p"
        />
      )}

      {!error && !isEmpty && (
        <ScrollArea
          className={cn('max-h-[70vh]', loading && 'pointer-events-none opacity-60')}
          aria-busy={loading}
        >
          <QueryResultList
            results={results}
            pageTitles={pageTitles}
            onNavigate={(pageId) => onNavigate?.(pageId, pageTitles.get(pageId))}
            layout="cards"
            ariaLabel={label}
          />
          <LoadMoreButton
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={handleLoadMore}
            className="mt-2"
            loadedCount={results.length}
            totalCount={totalCount ?? undefined}
          />
        </ScrollArea>
      )}
    </section>
  )
}

export function QueryBoard({ columns, ...query }: QueryBoardProps): React.ReactElement {
  return (
    <ScrollArea orientation="horizontal" data-testid="query-board">
      <div className="flex items-start gap-3 pb-3">
        {columns.map((column) => (
          <QueryBoardColumn key={column.id} column={column} {...query} />
        ))}
      </div>
    </ScrollArea>
  )
}
