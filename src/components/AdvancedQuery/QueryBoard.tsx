/**
 * QueryBoard — an advanced query's results as a board (#6542): one column per
 * value of the group key (`boardColumns`).
 *
 * Each column runs the query's own filter AND-ed with its value through
 * `useAdvancedQuery`, so a column pages by cursor on its own, keeps the query's
 * sort, full-text term and summaries, and a value no block has is an empty
 * column rather than a missing one.
 *
 * A card is a button that opens its page and a *Move to…* button whose menu
 * lists the other columns (`moveCard`). Each column has one Tab stop for its
 * cursor card and one for that card's move button; the arrow keys move the
 * cursor.
 */

import { ArrowRightLeft } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AggregateSummary } from '@/components/AdvancedQuery/AggregateSummary'
import type { BoardColumn } from '@/components/AdvancedQuery/board-columns'
import { moveCard } from '@/components/AdvancedQuery/board-move'
import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { TaskCheckbox } from '@/components/editor/TaskMarkerButton'
import {
  QueryResultRowContent,
  useRefTitleResolver,
} from '@/components/query/QueryResultRowContent'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAdvancedQuery } from '@/hooks/useAdvancedQuery'
import { pressesFocusedControl, useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { AggregateSpec, BlockRow, FilterExpr, SortKey } from '@/lib/bindings'
import { displayPageTitle } from '@/lib/date-utils'
import { resolveBlockDisplay } from '@/lib/query-result-utils'
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

/** A column a card can move to, under the name its header shows. */
interface MoveTarget {
  column: BoardColumn
  label: string
}

function MoveCardMenu({
  targets,
  tabIndex,
  onMove,
}: {
  targets: MoveTarget[]
  tabIndex: number
  onMove: (target: MoveTarget) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const label = t('advancedQuery.board.moveTo')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          variant="ghost"
          size="icon-sm"
          className="m-1 shrink-0"
          tooltip={label}
          ariaLabel={label}
          tabIndex={tabIndex}
        >
          <ArrowRightLeft aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <MenuPopoverContent align="end" className="w-48" aria-label={label}>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {targets.map((target) => (
            <li key={target.column.id}>
              <PopoverMenuItem
                onClick={() => {
                  setOpen(false)
                  onMove(target)
                }}
              >
                {target.label}
              </PopoverMenuItem>
            </li>
          ))}
        </ul>
      </MenuPopoverContent>
    </Popover>
  )
}

function QueryBoardCards({
  label,
  results,
  pageTitles,
  targets,
  onNavigate,
  onMove,
}: {
  label: string
  results: BlockRow[]
  pageTitles: Map<string, string>
  targets: MoveTarget[]
  onNavigate: BoardQuery['onNavigate']
  onMove: (block: BlockRow, target: MoveTarget) => void
}): React.ReactElement {
  const resolveRefTitle = useRefTitleResolver()
  const listRef = useRef<HTMLUListElement>(null)
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: results.length,
    // One list per column: a refetch after a move clamps the cursor, not resets it.
    resetKey: label,
    homeEnd: true,
    pageUpDown: true,
  })

  // Focus follows the cursor while it is in the list, so the next Tab leaves
  // from the cursor card.
  useEffect(() => {
    const list = listRef.current
    if (list?.contains(document.activeElement)) {
      list.querySelectorAll<HTMLElement>('[data-board-card]')[focusedIndex]?.focus()
    }
  }, [focusedIndex])

  return (
    /* oxlint-disable jsx-a11y/no-noninteractive-element-interactions -- the keys bubble up from the cards' own buttons; the list takes no focus itself */
    <ul
      ref={listRef}
      className="m-0 flex list-none flex-col gap-2 p-0"
      aria-label={label}
      onKeyDown={(e) => {
        // Enter and Space press the focused button; a key in the open menu is the menu's.
        if (pressesFocusedControl(e.nativeEvent, listRef.current)) return
        if (handleKeyDown(e)) e.preventDefault()
      }}
    >
      {results.map((block, index) => {
        const {
          title,
          displayMarkdown,
          pageTitle: storedPageTitle,
        } = resolveBlockDisplay(block, pageTitles, undefined, resolveRefTitle)
        const pageTitle = block.parent_id && storedPageTitle && displayPageTitle(storedPageTitle)
        const tabIndex = index === focusedIndex ? 0 : -1
        return (
          <li key={block.id} className="flex items-start rounded-lg border bg-card">
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-start gap-x-2 gap-y-1 rounded-lg p-3 text-left text-sm transition-colors hover:bg-muted/40 focus-ring-visible"
              data-testid="query-board-card"
              data-board-card
              data-block-id={block.id}
              tabIndex={tabIndex}
              // The name carries what the card shows: the state, the text, the page.
              aria-label={[block.todo_state, title, pageTitle].filter(Boolean).join(' ')}
              onClick={() => {
                if (block.page_id) onNavigate?.(block.page_id, pageTitles.get(block.page_id))
              }}
            >
              {block.todo_state && <TaskCheckbox state={block.todo_state} />}
              <span className="line-clamp-3 min-w-0 flex-1">
                {displayMarkdown !== null ? (
                  <QueryResultRowContent content={displayMarkdown} />
                ) : (
                  title
                )}
              </span>
              {pageTitle && (
                <span className="basis-full truncate text-xs text-muted-foreground">
                  {pageTitle}
                </span>
              )}
            </button>
            <MoveCardMenu
              targets={targets}
              tabIndex={tabIndex}
              onMove={(target) => onMove(block, target)}
            />
          </li>
        )
      })}
    </ul>
    /* oxlint-enable jsx-a11y/no-noninteractive-element-interactions */
  )
}

function QueryBoardColumn({
  column,
  label,
  targets,
  onMoved,
  filter,
  fulltext,
  sort,
  aggregates,
  onNavigate,
}: BoardQuery & {
  column: BoardColumn
  label: string
  targets: MoveTarget[]
  /** A card is leaving this column for `target`. */
  onMoved: (target: BoardColumn) => void
}): React.ReactElement | null {
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

  const isEmpty = results.length === 0

  // Values outside the options are the exception; no column for none of them.
  if (column.kind === 'other' && isEmpty && !error) return null

  return (
    <section
      className="flex w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-lg bg-muted/50 p-2 focus-ring-visible"
      aria-label={label}
      data-testid="query-board-column"
      data-column-id={column.id}
      // Takes the focus when the card that held it moves out of a column.
      tabIndex={-1}
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
          <QueryBoardCards
            label={label}
            results={results}
            pageTitles={pageTitles}
            targets={targets}
            onNavigate={onNavigate}
            onMove={(block, target) => {
              onMoved(target.column)
              void moveCard(block, target.column, target.label)
            }}
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
  const { t } = useTranslation()
  const boardRef = useRef<HTMLDivElement>(null)
  const labelled = columns.map((column): MoveTarget => ({
    column,
    label:
      column.kind === 'value'
        ? (column.value ?? '')
        : t(column.kind === 'none' ? 'advancedQuery.board.noValue' : 'advancedQuery.board.other'),
  }))
  // A value outside the options is not one a card can be given.
  const targets = labelled.filter((target) => target.column.kind !== 'other')
  return (
    <ScrollArea orientation="horizontal" data-testid="query-board">
      <div ref={boardRef} className="flex items-start gap-3 pb-3">
        {labelled.map(({ column, label }) => (
          <QueryBoardColumn
            key={column.id}
            column={column}
            label={label}
            targets={targets.filter((target) => target.column !== column)}
            // The moved card's buttons unmount under the focus. The column it
            // left takes it, or the one it went to when the last card out of
            // "Other values" removes that column.
            onMoved={(target) => {
              const id = column.kind === 'other' ? target.id : column.id
              boardRef.current
                ?.querySelector<HTMLElement>(`[data-column-id="${CSS.escape(id)}"]`)
                ?.focus()
            }}
            {...query}
          />
        ))}
      </div>
    </ScrollArea>
  )
}
