/**
 * AgendaResults -- flat results list for the agenda view (#606).
 *
 * Replaces the 3 hardcoded TaskSection panels (TODO/DOING/DONE) with a single
 * flat list of blocks. Each item shows: status icon, priority badge, due date
 * chip, content text, and a source page breadcrumb.
 *
 * This is a pure presentation component — the parent is responsible for
 * fetching, filtering, and passing down blocks.
 */

import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { useVirtualizedGroupedRows } from '@/hooks/useVirtualizedGroupedRows'
import {
  type AgendaGroup,
  type AgendaSortBy,
  getAgendaGroupKey,
  groupByDate,
  groupByPage,
  groupByPriority,
  groupByState,
  sortAgendaBlocksBy,
} from '@/lib/agenda-sort'
import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

export interface AgendaResultsProps {
  /** Pre-filtered blocks to display. If empty, shows empty state. */
  blocks: BlockRow[]
  /** Whether blocks are still loading */
  loading: boolean
  /**
   * Whether the initial agenda query failed (#1345). When true a distinct
   * error card with a Retry action is rendered instead of the benign
   * "No tasks found" / "No blocks match" empty state.
   */
  error?: boolean | undefined
  /** Re-run the agenda query (wired to the error card's Retry button). */
  onRetry?: (() => void) | undefined
  /** Whether more blocks can be loaded */
  hasMore: boolean
  /** Load more callback */
  onLoadMore: () => void
  /** Navigate to a block's source page */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** Whether any filters are active (affects empty state messaging) */
  hasActiveFilters: boolean
  /** Clear all filters callback */
  onClearFilters: () => void
  /** Resolved page titles for breadcrumbs */
  pageTitles: Map<string, string>
  /** Group blocks by this dimension. Default: 'none'. */
  groupBy?: ('date' | 'priority' | 'state' | 'page' | 'none') | undefined
  /** Primary sort key. Default: 'date'. */
  sortBy?: AgendaSortBy | undefined
  /** Callback fired when a date is changed inline (e.g. to refresh blocks). */
  onDateChanged?: (() => void) | undefined
}

/**
 * Which i18n key (if any) a group header should be translated with.
 *
 * Keyed off the DISCRIMINANT, not the display label. Three states, and the
 * middle one is the whole point (#3845):
 *
 *   `SpecialLabel` — a genuine special bucket; translate it.
 *   `null`         — a `groupByDate` DATE bucket; NEVER translate, whatever
 *                    it happens to be labelled. A hand-edited `due_date`
 *                    spelling `'Today'` formats to the label `Today` and
 *                    would otherwise resolve to `agenda.today`.
 *   `undefined`    — the group came from a grouper with no discriminant
 *                    (`groupByPage` / `groupByPriority` / `groupByState`),
 *                    where the label IS the key (e.g. `'No page'`).
 *
 * `special ?? label` alone would collapse `null` into the label path and
 * leave the collision exactly as it was — a discriminant that exists but is
 * not consulted reads as fixed while behaving as before.
 *
 * Exported for tests: under the app's single pinned locale
 * `t('agenda.today')` renders the literal string `Today`, identical to the
 * raw label, so this decision is NOT observable through a rendered header.
 * Testing it directly is what makes it covered rather than merely written.
 */
export function groupI18nKey(
  group: AgendaGroup,
  lookup: ReadonlyMap<string, string>,
): string | undefined {
  if (group.special === null) return undefined
  return lookup.get(group.special ?? group.label)
}

// ── Component ──────────────────────────────────────────────────────────

export function AgendaResults({
  blocks,
  loading,
  error = false,
  onRetry,
  hasMore,
  onLoadMore,
  onNavigateToPage,
  hasActiveFilters,
  onClearFilters,
  pageTitles,
  groupBy,
  sortBy = 'date',
  onDateChanged,
}: AgendaResultsProps): React.ReactElement {
  const { t } = useTranslation()

  const { handleBlockClick: handleItemClick, getRowHandlers } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('agenda.untitled'),
  })

  // Properties for every visible agenda row are
  // fetched in a single `getBatchProperties` IPC mounted via
  // `BatchPropertiesProvider` below. The previous per-row
  // `getProperties` fan-out (deduped only across re-renders, not
  // across initial mount of N rows) is gone.
  //
  // The provider re-fetches whenever
  // `useBlockPropertyEvents().invalidationKey` bumps OR the active
  // space switches, so the dependency indicator reflects fresh data
  // after edits. We pass a stable composite key into the provider
  // rather than driving a separate cache-clear effect.
  const { invalidationKey: propertyInvalidationKey } = useBlockPropertyEvents()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const batchInvalidationKey = `${propertyInvalidationKey}|${currentSpaceId ?? ''}`

  // ── Keyboard navigation ────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null)
  // perf-review Tier 2 #6 (2026-05-14) — scroll container ref for the
  // virtualizer. Distinct from `listRef` (the keyboard-nav container
  // that holds the result-count `role="status"` and the
  // `LoadMoreButton`); the virtualizer needs to scroll the inner
  // flat-row container, while keyboard arrow keys still target the
  // outer `listRef`.
  const scrollParentRef = useRef<HTMLDivElement>(null)

  // Sort once for the flat (no-group) display path. The grouping helpers
  // (groupByDate / groupByPriority / groupByState / groupByPage) all re-sort
  // internally with their own group-specific key chains, so feeding them a
  // Pre-sorted list would just be thrown away. Per we picked option
  // (a) — keep the helpers' internal sort and feed every grouping branch
  // raw `blocks` — because option (b) would require changing helper sort
  // behaviour, which the task forbids. `sortedBlocks` is therefore consumed
  // only by the flat fallback below.
  const sortedBlocks = useMemo(
    () => sortAgendaBlocksBy(blocks, sortBy, pageTitles),
    [blocks, sortBy, pageTitles],
  )

  // Compute groups for display (needed before flatItems)
  const groups = useMemo(() => {
    if (groupBy === 'date') return groupByDate(blocks)
    if (groupBy === 'priority') return groupByPriority(blocks)
    if (groupBy === 'state') return groupByState(blocks)
    if (groupBy === 'page') return groupByPage(blocks, pageTitles)
    return null
  }, [blocks, groupBy, pageTitles])

  const flatItems = useMemo(
    () => (groups ? groups.flatMap((g) => g.blocks) : sortedBlocks),
    [groups, sortedBlocks],
  )

  // Stable list of block IDs for the BatchPropertiesProvider. The
  // provider derives a sorted membership key internally so a new array
  // reference with identical contents does NOT trigger a refetch.
  const allBlockIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: flatItems.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = flatItems[idx]
      if (block) handleItemClick(block)
    },
  })

  // Reset focused index when blocks / sort / group change
  useEffect(() => {
    setFocusedIndex(0)
  }, [blocks, sortBy, groupBy, setFocusedIndex])

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14; #2252) ──────
  // Map group labels to i18n keys for known groups; consumed by the
  // grouped-header render path below (display label is derived from the
  // raw `group.label` per visible header at render time).
  //
  // A `Map`, not a plain object literal: the key is the raw, unsanitized
  // `group.label`. A `Record<string, string>` indexed by that label
  // resolves `'constructor'` (or `'__proto__'`) through the prototype
  // chain to `Object.prototype.constructor` — a function, therefore
  // truthy — handing `t()` a function instead of a translation key, which
  // renders as `''` and strips the header's text. The exact hazard #3814
  // fixed one layer up, reappearing here (#3845). `Map#get` has no
  // prototype chain to leak through.
  //
  // Which labels actually reach this lookup is worth being precise about,
  // because the obvious answer is wrong: NOT `groupByDate`'s. A date
  // bucket carries `special: null`, so `groupI18nKey` early-returns before
  // touching the map. The live hazard is the groupers that set no
  // discriminant — `groupByPage` / `groupByState` / `groupByPriority` —
  // whose labels are user-controlled, e.g. a page TITLED `constructor`.
  // That is the case the regression test drives; a date-driven one stays
  // green with the `Record` restored and proves nothing.
  const GROUP_I18N: Map<string, string> = useMemo(
    () =>
      new Map([
        ['Overdue', 'agenda.overdue'],
        ['Today', 'agenda.today'],
        ['Tomorrow', 'agenda.tomorrow'],
        ['No date', 'agenda.noDate'],
        ['No page', 'agenda.noPage'],
      ]),
    [],
  )

  // Shared grouped-list scaffolding (#2252): `useVirtualizedGroupedRows`
  // builds the flat row list consumed by the virtualizer. When grouped,
  // a `group-header` row is interspersed before each group's items so
  // the virtualizer treats headers and items as siblings and can skip
  // the entire offscreen tree; when `groupBy` is 'none' (`groups` null)
  // the sorted blocks render headerless. The `flatItemIndex` field
  // threads each item row back to the `flatItems` array so keyboard-nav
  // focus mapping (`focusedIndex` indexes `flatItems`) stays correct,
  // and the hook owns the focused-row scroll-into-view effect.
  const { virtualRows, virtualizer } = useVirtualizedGroupedRows({
    groups,
    ungroupedItems: sortedBlocks,
    getGroupKey: getAgendaGroupKey,
    getGroupItems: (g) => g.blocks,
    // Header rows are ~36px (`px-3 py-1` + sm text); item rows render a
    // `BlockListItem` whose default touch min-height is 44px, but with
    // metadata + breadcrumb gap the typical observed height is ~56px.
    headerHeight: 36,
    itemHeight: 56,
    focusedIndex,
    scrollParentRef,
  })

  // ── Error state (#1345) ────────────────────────────────────────────
  // The initial agenda query failed. Render a distinct, retryable error
  // card instead of the benign empty state so a backend failure is not
  // mistaken for an empty agenda. Mirrors the SearchPanel error card
  // (role="alert" + destructive-tinted card) and adds a Retry action.
  // Takes precedence over loading/empty so the failure isn't masked by a
  // stale skeleton.
  if (error && !loading) {
    return (
      <div
        role="alert"
        data-testid="agenda-error-state"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <p className="font-medium">{t('agenda.loadFailed')}</p>
        <p className="text-destructive/90">{t('agenda.loadFailedBody')}</p>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="mt-3"
            data-testid="agenda-error-retry"
          >
            {t('action.retry')}
          </Button>
        )}
      </div>
    )
  }

  // ── Loading state (initial load, no blocks yet) ────────────────────
  if (loading && blocks.length === 0) {
    return (
      <div
        className="agenda-results-loading flex items-center justify-center gap-2 py-8"
        aria-busy="true"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> defaults to display:inline and would break this flex centering container; keep role="status" on the div
        role="status"
      >
        <LoadingSkeleton count={3} height="h-10" />
      </div>
    )
  }

  // ── Empty states ───────────────────────────────────────────────────
  if (blocks.length === 0) {
    if (hasActiveFilters) {
      return (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> only permits phrasing content; this wraps the block-level <EmptyState>, so keep role="status" on the div
        <div role="status">
          <EmptyState
            message={t('agenda.noMatch')}
            action={
              <Button variant="outline" size="sm" onClick={onClearFilters} className="mt-2">
                {t('agenda.clearFilters')}
              </Button>
            }
          />
        </div>
      )
    }
    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> only permits phrasing content; this wraps the block-level <EmptyState>, so keep role="status" on the div
      <div role="status">
        <EmptyState message={t('agenda.noTasks')} />
      </div>
    )
  }

  // ── Results list ───────────────────────────────────────────────────

  /** Render a single agenda item (shared between flat and grouped modes). */
  function renderItem(
    block: BlockRow,
    currentFlatIndex: number,
    virtualRow: { key: React.Key; index: number; start: number },
  ) {
    // Tier 1.4 (perf-review 2026-05-09): stable per-block handlers from the
    // `useBlockNavigation` factory + typed primitive metadata props so
    // `BlockListItem.memo` shallow-compare hits cleanly across parent
    // re-renders (perf-review 2026-05-14 follow-up).
    const rowHandlers = getRowHandlers(block)
    return (
      <BlockListItem
        key={virtualRow.key}
        liRef={virtualizer.measureElement}
        dataIndex={virtualRow.index}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualRow.start}px)`,
        }}
        content={block.content}
        // Metadata primitives — rendered by `BlockListItem`'s internal
        // `BlockMetadataRow` sub-component (memoed) so a parent re-render
        // without prop changes does NOT allocate fresh React elements per row.
        statusIconState={block.todo_state}
        priority={block.priority}
        priorityVariant="agenda"
        dueDate={block.due_date}
        dueDateBlockId={block.id}
        {...(onDateChanged !== undefined && { onDateChanged })}
        dependencyBlockId={block.id}
        pageId={block.page_id}
        pageTitle={pageTitles.get(block.page_id ?? '') ?? t('agenda.untitled')}
        breadcrumbArrow={t('agenda.breadcrumbArrow')}
        className="agenda-results-item hover:bg-accent/50 active:bg-accent/70"
        contentClassName="agenda-results-text"
        breadcrumbClassName="agenda-results-breadcrumb"
        testId="agenda-results-item"
        onClick={rowHandlers.onClick}
        onKeyDown={rowHandlers.onKeyDown}
        isFocused={focusedIndex === currentFlatIndex}
      />
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <BatchPropertiesProvider blockIds={allBlockIds} invalidationKey={batchInvalidationKey}>
      {/* #1520 — roving tabindex: the focused `BlockListItem` row is the
          single tab stop (others are `tabIndex=-1`), so the container must NOT
          carry `tabIndex={0}` or the list would have a doubled keyboard model.
          The arrow-key handler stays here and fires via keydown bubbling from
          the focused row. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container (events bubble from the roving row); not itself focusable */}
      <div
        className="agenda-results space-y-2"
        ref={listRef}
        onKeyDown={(e) => {
          if (navHandleKeyDown(e)) e.preventDefault()
        }}
      >
        {/* Screen-reader result count */}
        <output className="sr-only">
          {blocks.length === 1
            ? t('agenda.resultOne')
            : t('agenda.resultCount', { count: blocks.length })}
        </output>

        {/* #3291 — the displayed order is only as complete as the fetched
            window. Sorting and grouping both run client-side over `blocks`,
            so while `hasMore` is true the "top" item is the best of what has
            been loaded, not of the agenda.

            The trigger is `hasMore` ALONE — deliberately not "hasMore && a
            non-date sort is active". Every query feeding this panel paginates
            in ULID order, not date order:
              - `query_by_property`  (agaric-store/src/pagination/properties.rs)
              - `list_undated_tasks` (agaric-store/src/pagination/undated.rs)
              - `filtered_blocks_query` (src-tauri/src/commands/queries.rs)
            all end in `ORDER BY b.id ASC`. So the fetched 200 rows are the 200
            oldest-created matches — a set uncorrelated with due date. `'date'`
            (this component's prop default; the SHIPPED default from
            `useAgendaPreferences` is `'state'`) therefore orders an arbitrary
            window exactly as `'priority'` does, and exempting it would promise
            a completeness the backend never provides. Truncation, not the
            choice of sort key, is the whole defect.

            PageBrowser gates the same cue on
            `isFrontendOnlySort(sortOption) && hasMore` (PageBrowser.tsx) —
            because SOME of its sorts ARE pushed into SQL
            (commands/pages/metadata.rs `ORDER BY {key_expr}`). No agenda sort
            is. The predicate here is that same one with its first conjunct
            collapsed to `true`, not a laxer rule.

            Rendered above the list (not next to the Load more button, which
            sits below a scrolling viewport) so it is adjacent to the item
            whose primacy it qualifies. Mirrors the SearchPanel 5000-item
            capped notice: same `role="status"` polite live region, announced
            on appearance, never blocking. */}
        {hasMore && (
          <div
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level notice card (border/padding/rounded); <output> is inline-level and would break the boxed layout
            role="status"
            data-testid="agenda-partial-order-notice"
            className="agenda-partial-order-notice rounded-lg border border-alert-warning-border bg-alert-warning p-2 text-xs text-alert-warning-foreground"
          >
            {t('agenda.partialOrderNotice')}
          </div>
        )}

        {/* Virtualized list (perf-review Tier 2 #6, 2026-05-14).
            Headers + items are interleaved as flat virtual rows so the
            virtualizer can drop offscreen subtrees entirely; this
            replaces the previous nested `groups.map(group => group.blocks.map(item))`
            tree-walk.

            `BlockListItem` renders an `<li>` directly, so each virtual
            row uses `<li>` (item rows) or `<li role="presentation">`
            (group-header rows) under a single `<ul>` parent. This
            keeps the listitem axe rule happy in both flat and grouped
            modes without re-wrapping `BlockListItem` in an extra `<li>`
            (which would also have failed the rule for nested `<li>`s). */}
        <ScrollArea
          viewportRef={scrollParentRef}
          // pr-2.5 reserves room for the classic 10px scrollbar gutter so a
          // focused/selected row's full rounded border (the right side in
          // particular) renders inside the viewport instead of being clipped
          // under the scrollbar. The `<ul>` is a block child of the viewport,
          // so this right padding narrows the `width:100%` absolute rows with
          // it — keeping all four border sides visible.
          // The vertical budget grows by the notice's own height when the
          // notice is shown. Without this the notice pushes `LoadMoreButton`
          // — the exact control its copy tells the user to press — further
          // down the page, which is self-defeating. Nothing is clipped either
          // way (`App.tsx` wraps the main content in a scroller), so this is
          // about keeping the button where the user last saw it.
          viewportClassName={`agenda-results-scroll pr-2.5 ${
            hasMore ? 'max-h-[calc(100dvh-300px)]' : 'max-h-[calc(100dvh-260px)]'
          }`}
        >
          <ul
            className="agenda-results-list relative m-0 p-0 list-none"
            aria-label={t('agenda.agendaResults')}
            style={{ height: `${totalSize}px` }}
          >
            {virtualItems.map((virtualRow) => {
              const row = virtualRows[virtualRow.index]
              if (!row) return null
              const rowStyle: React.CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }
              if (row.kind === 'group-header') {
                const i18nKey = groupI18nKey(row.group, GROUP_I18N)
                const displayLabel = i18nKey ? t(i18nKey) : row.group.label
                return (
                  // Group headers ride a `<li>` so they're a valid
                  // child of the surrounding `<ul>` (axe's `list` rule
                  // rejects non-`<li>` children, and `role="presentation"`
                  // on the `<li>` would also fail because it strips
                  // the listitem role — see the inline `<h3>` below
                  // which is what screen readers should land on).
                  <li
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={rowStyle}
                    className="agenda-group"
                  >
                    <h3
                      className={cn(
                        'agenda-group-header text-sm font-semibold uppercase tracking-wide px-3 py-1',
                        row.group.className ?? 'text-muted-foreground',
                      )}
                      data-testid="agenda-group-header"
                    >
                      {displayLabel}
                      <span className="ml-1.5 text-muted-foreground font-normal">
                        ({row.group.blocks.length})
                      </span>
                    </h3>
                  </li>
                )
              }
              // `BlockListItem` IS a `<li>`. Pass the virtualizer's
              // positioning style + ref + data-index through `liRef` /
              // `style` / `dataIndex` so the row is a direct child of
              // the `<ul>` (no nested-`<li>` HTML violation, exactly
              // one listitem-roled element per row).
              return renderItem(row.item, row.flatItemIndex, virtualRow)
            })}
          </ul>
        </ScrollArea>

        {/* Load more */}
        <LoadMoreButton
          hasMore={hasMore}
          loading={loading}
          onLoadMore={onLoadMore}
          className="agenda-results-load-more mt-2"
          label={t('agenda.loadMore')}
          loadingLabel={t('agenda.loading')}
          ariaLabel={t('agenda.loadMoreLabel')}
          ariaLoadingLabel={t('agenda.loadingMore')}
        />
      </div>
    </BatchPropertiesProvider>
  )
}
