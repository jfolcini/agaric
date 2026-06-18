/**
 * Tests for AgendaView component.
 *
 * Validates:
 *  1. Smoke render with filter builder, sort controls, and results
 *  2. Loading state shows on initial mount
 *  3. Renders agenda results with blocks from executeAgendaFilters
 *  4. Empty state when no blocks returned
 *  5. Error state clears blocks gracefully
 *  6. Resolves page titles via batchResolve
 *  7. Passes onNavigateToPage down to AgendaResults
 *  8. Filter changes trigger re-fetch (via AgendaFilterBuilder callback)
 *  9. Clear filters resets to empty filter array
 * 10. Load more routes through loadMoreAgendaFilters (active filters) /
 *     loadMoreUnfilteredAgenda (no filters, #721)
 * 11. Sort/group controls pass through to AgendaResults
 * 12. A11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock agenda-filters ─────────────────────────────────────────────
vi.mock('../../../lib/agenda-filters', () => ({
  executeAgendaFilters: vi.fn(),
  loadMoreAgendaFilters: vi.fn(),
  loadMoreUnfilteredAgenda: vi.fn(),
}))

// ── Mock tauri lib ──────────────────────────────────────────────────
vi.mock('../../../lib/tauri', () => ({
  batchResolve: vi.fn(),
  queryByProperty: vi.fn(),
  paginationLimit: (n: number) => n,
}))

// ── Mock logger ─────────────────────────────────────────────────────
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ── Capture props from AgendaFilterBuilder ──────────────────────────
const { filterChangeRef } = vi.hoisted(() => ({
  filterChangeRef: { current: null as ((filters: unknown[]) => void) | null },
}))

vi.mock('@/components/agenda/AgendaFilterBuilder', () => ({
  AgendaFilterBuilder: (props: { filters: unknown[]; onFiltersChange: unknown }) => {
    filterChangeRef.current = props.onFiltersChange as (filters: unknown[]) => void
    return (
      <div
        data-testid="agenda-filter-builder"
        data-filter-count={Array.isArray(props.filters) ? props.filters.length : 0}
      >
        AgendaFilterBuilder
      </div>
    )
  },
  AgendaSortGroupControls: (props: {
    groupBy: string
    sortBy: string
    onGroupByChange: unknown
    onSortByChange: unknown
  }) => {
    return (
      <div
        data-testid="agenda-sort-group-controls"
        data-group-by={props.groupBy}
        data-sort-by={props.sortBy}
      >
        AgendaSortGroupControls
      </div>
    )
  },
}))

// ── Capture props from AgendaResults ────────────────────────────────
const { clearFiltersRef, loadMoreRef, retryRef } = vi.hoisted(() => ({
  clearFiltersRef: { current: null as (() => void) | null },
  loadMoreRef: { current: null as (() => void) | null },
  retryRef: { current: null as (() => void) | null },
}))

vi.mock('@/components/agenda/AgendaResults', () => ({
  AgendaResults: (props: {
    blocks: unknown[]
    loading: boolean
    error?: boolean
    onRetry?: () => void
    hasMore: boolean
    hasActiveFilters: boolean
    onClearFilters: () => void
    onLoadMore: () => void
    onNavigateToPage?: unknown
    pageTitles: Map<string, string>
    groupBy: string
    sortBy: string
  }) => {
    clearFiltersRef.current = props.onClearFilters
    loadMoreRef.current = props.onLoadMore
    retryRef.current = props.onRetry ?? null
    return (
      <div
        data-testid="agenda-results"
        data-block-count={Array.isArray(props.blocks) ? props.blocks.length : 0}
        data-loading={String(props.loading)}
        data-error={String(!!props.error)}
        data-has-more={String(props.hasMore)}
        data-has-active-filters={String(props.hasActiveFilters)}
        data-has-navigate={String(!!props.onNavigateToPage)}
        data-group-by={props.groupBy}
        data-sort-by={props.sortBy}
        data-page-titles={JSON.stringify([...props.pageTitles.entries()])}
      >
        AgendaResults
      </div>
    )
  },
}))

// ── Mock notify (load-more retry surface, #1345) ────────────────────
vi.mock('@/lib/notify', () => ({
  notify: {
    retry: vi.fn(),
  },
}))

import { notify } from '@/lib/notify'

import { makeBlock as _makeBlock } from '../../../__tests__/fixtures'
import {
  executeAgendaFilters,
  loadMoreAgendaFilters,
  loadMoreUnfilteredAgenda,
} from '../../../lib/agenda-filters'
import { batchResolve, queryByProperty } from '../../../lib/tauri'
import { AgendaView } from '../AgendaView'

const mockedNotifyRetry = vi.mocked(notify.retry)
const mockedExecuteAgendaFilters = vi.mocked(executeAgendaFilters)
const mockedLoadMoreAgendaFilters = vi.mocked(loadMoreAgendaFilters)
const mockedLoadMoreUnfilteredAgenda = vi.mocked(loadMoreUnfilteredAgenda)
const mockedBatchResolve = vi.mocked(batchResolve)
const mockedQueryByProperty = vi.mocked(queryByProperty)

/** Shared factory + domain defaults for AgendaView tests. */
const makeBlock = (overrides: Parameters<typeof _makeBlock>[0] = {}) =>
  _makeBlock({
    id: 'B1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE1',
    page_id: 'PAGE1',
    due_date: '2025-06-15',
    ...overrides,
  })

beforeEach(() => {
  vi.clearAllMocks()
  filterChangeRef.current = null
  clearFiltersRef.current = null
  loadMoreRef.current = null
  retryRef.current = null
  // Default: no blocks, no errors
  mockedExecuteAgendaFilters.mockResolvedValue({
    blocks: [],
    hasMore: false,
    cursor: null,
  })
  mockedBatchResolve.mockResolvedValue([])
  mockedQueryByProperty.mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
  mockedLoadMoreAgendaFilters.mockResolvedValue({
    blocks: [],
    hasMore: false,
    cursor: null,
  })
  mockedLoadMoreUnfilteredAgenda.mockResolvedValue({
    blocks: [],
    hasMore: false,
    cursor: null,
  })
  // Clear localStorage for sort/group preferences
  localStorage.removeItem('agaric:agenda:groupBy')
  localStorage.removeItem('agaric:agenda:sortBy')
})

describe('AgendaView', () => {
  // 1. Smoke render with all three child sections
  it('renders filter builder, sort controls, and results', async () => {
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
    expect(screen.getByTestId('agenda-sort-group-controls')).toBeInTheDocument()
    expect(screen.getByTestId('agenda-results')).toBeInTheDocument()
  })

  // 2. Loading state on initial mount
  it('shows loading state while fetching', async () => {
    // Never-resolving promise to keep loading
    mockedExecuteAgendaFilters.mockReturnValue(new Promise(() => {}))

    render(<AgendaView />)

    // Should show loading initially
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'true')
  })

  // 3. Renders agenda results with blocks
  it('renders blocks from executeAgendaFilters', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [
        makeBlock({ id: 'B1', parent_id: 'PAGE1' }),
        makeBlock({ id: 'B2', parent_id: 'PAGE1' }),
        makeBlock({ id: 'B3', parent_id: 'PAGE2', page_id: 'PAGE2' }),
      ],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '3')
    })

    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
  })

  // 4. Empty state when no blocks returned
  it('renders zero blocks in empty state', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '0')
  })

  // 5. Error state clears blocks gracefully
  it('clears blocks on error', async () => {
    // First render succeeds with blocks
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '1')
    })

    // Now simulate filter change that errors
    mockedExecuteAgendaFilters.mockRejectedValueOnce(new Error('backend error'))

    // Trigger filter change
    filterChangeRef.current?.([{ dimension: 'status', values: ['TODO'] }])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '0')
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })
  })

  // 5b. #1345 — initial query failure surfaces the error state (not the
  // benign empty state) and Retry re-runs the filters.
  it('#1345: surfaces error state on query failure and Retry re-runs filters', async () => {
    mockedExecuteAgendaFilters.mockRejectedValueOnce(new Error('backend down'))

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-error', 'true')
    })
    // Failure must NOT masquerade as a loading or empty-success state.
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '0')

    // Retry re-invokes the query; a now-successful run drops the error and
    // shows the fetched block.
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [makeBlock({ id: 'B_AFTER_RETRY' })],
      hasMore: false,
      cursor: null,
    })

    expect(retryRef.current).not.toBeNull()
    retryRef.current?.()

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-error', 'false')
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '1')
    })
    expect(mockedExecuteAgendaFilters).toHaveBeenCalledTimes(2)
  })

  // 5c. #1345 — a load-more failure surfaces a retryable notification wired
  // to the load-more callback (not swallowed silently).
  it('#1345: load-more failure calls notify.retry with the load-more callback', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: true,
      cursor: 'cursor_page2',
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'true')
    })

    mockedLoadMoreAgendaFilters.mockRejectedValueOnce(new Error('load more failed'))

    loadMoreRef.current?.()

    await waitFor(() => {
      expect(mockedNotifyRetry).toHaveBeenCalledTimes(1)
    })
    // The retry callback handed to notify.retry is the same load-more
    // function exposed to AgendaResults, so invoking it re-attempts the page.
    const retryArg = mockedNotifyRetry.mock.calls[0]?.[1]
    expect(retryArg).toBe(loadMoreRef.current)
  })

  // 6. Resolves page titles via batchResolve
  it('resolves page titles via batchResolve', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [
        makeBlock({ id: 'B1', parent_id: 'PAGE1' }),
        makeBlock({ id: 'B2', parent_id: 'PAGE2', page_id: 'PAGE2' }),
      ],
      hasMore: false,
      cursor: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'First Page', block_type: 'page', deleted: false },
      { id: 'PAGE2', title: 'Second Page', block_type: 'page', deleted: false },
    ])

    render(<AgendaView />)

    await waitFor(() => {
      const results = screen.getByTestId('agenda-results')
      const titles = JSON.parse(results.getAttribute('data-page-titles') ?? '[]')
      expect(titles).toEqual(
        expect.arrayContaining([
          ['PAGE1', 'First Page'],
          ['PAGE2', 'Second Page'],
        ]),
      )
    })

    expect(mockedBatchResolve).toHaveBeenCalledWith(['PAGE1', 'PAGE2'])
  })

  // 6b. Resolves page_ids for page grouping
  it('resolves page_ids via batchResolve', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [
        makeBlock({ id: 'B1', parent_id: 'PARENT1', page_id: 'PAGEROOT1' }),
        makeBlock({ id: 'B2', parent_id: 'PARENT2', page_id: 'PAGEROOT2' }),
        makeBlock({ id: 'B3', parent_id: 'PARENT2', page_id: null }),
      ],
      hasMore: false,
      cursor: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGEROOT1', title: 'Page Root One', block_type: 'page', deleted: false },
      { id: 'PAGEROOT2', title: 'Page Root Two', block_type: 'page', deleted: false },
    ])

    render(<AgendaView />)

    await waitFor(() => {
      const results = screen.getByTestId('agenda-results')
      const titles = JSON.parse(results.getAttribute('data-page-titles') ?? '[]')
      expect(titles).toEqual(
        expect.arrayContaining([
          ['PAGEROOT1', 'Page Root One'],
          ['PAGEROOT2', 'Page Root Two'],
        ]),
      )
    })

    // batchResolve should only be called with page_ids (deduplicated, nulls removed)
    expect(mockedBatchResolve).toHaveBeenCalledTimes(1)
    const resolvedIds = mockedBatchResolve.mock.calls[0]?.[0] as string[]
    expect(resolvedIds).toContain('PAGEROOT1')
    expect(resolvedIds).toContain('PAGEROOT2')
    // parent_ids should NOT be included (source now only collects page_id)
    expect(resolvedIds).not.toContain('PARENT1')
    expect(resolvedIds).not.toContain('PARENT2')
    // null page_id should not be included
    expect(resolvedIds).not.toContain(null)
  })

  // 7. Passes onNavigateToPage down to AgendaResults
  it('passes onNavigateToPage to AgendaResults', async () => {
    const onNavigate = vi.fn()

    render(<AgendaView onNavigateToPage={onNavigate} />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-navigate', 'true')
  })

  // 7b. Without onNavigateToPage, results get false
  it('AgendaResults gets data-has-navigate=false without onNavigateToPage', async () => {
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-navigate', 'false')
  })

  // 8. Filter changes trigger re-fetch
  it('filter changes trigger re-fetch', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    expect(mockedExecuteAgendaFilters).toHaveBeenCalledTimes(1)
    // UX-196: agenda now opens with a TODO+DOING status filter by default.
    // FEAT-3 Phase 4 — `executeAgendaFilters` now takes `spaceId` as
    // its second positional arg (`null` here because no space is seeded).
    expect(mockedExecuteAgendaFilters).toHaveBeenCalledWith(
      [{ dimension: 'status', values: ['TODO', 'DOING'] }],
      null,
    )

    // Simulate filter change from AgendaFilterBuilder
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [makeBlock({ id: 'B_FILTERED' })],
      hasMore: false,
      cursor: null,
    })

    filterChangeRef.current?.([{ dimension: 'status', values: ['TODO'] }])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '1')
    })

    expect(mockedExecuteAgendaFilters).toHaveBeenCalledTimes(2)
    // FEAT-3 Phase 4 — `executeAgendaFilters` now takes `spaceId` as
    // its second positional arg (`null` here, no seeded space).
    expect(mockedExecuteAgendaFilters).toHaveBeenLastCalledWith(
      [{ dimension: 'status', values: ['TODO'] }],
      null,
    )
  })

  // 8b. AgendaFilterBuilder shows updated filter count
  it('AgendaFilterBuilder shows updated filter count after change', async () => {
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    // UX-196: agenda now opens with 1 default filter (TODO+DOING status).
    expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '1')

    // Replace with a different filter via AgendaFilterBuilder
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    filterChangeRef.current?.([
      { dimension: 'status', values: ['TODO', 'DOING'] },
      { dimension: 'priority', values: ['1'] },
    ])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '2')
    })
  })

  // 9. #1744 — "Clear filters" restores the DEFAULT view (TODO + DOING),
  // NOT an empty filter array (which would broaden to the completed-
  // inclusive unfiltered superset). The label means "neutral reset to
  // default", so DONE must stay excluded after a clear.
  it('clearing filters restores the default TODO+DOING view (not an unfiltered superset)', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    // First narrow to a non-default filter so "Clear filters" is offered.
    filterChangeRef.current?.([{ dimension: 'status', values: ['TODO'] }])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute(
        'data-has-active-filters',
        'true',
      )
    })

    // Now clear filters via AgendaResults callback.
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    clearFiltersRef.current?.()

    await waitFor(() => {
      // Clear restores the default (a single TODO+DOING status filter), so
      // the view is no longer "actively filtered" beyond the default…
      expect(screen.getByTestId('agenda-results')).toHaveAttribute(
        'data-has-active-filters',
        'false',
      )
      // …but the filter is NOT emptied — the default chip remains.
      expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '1')
    })

    // The fetch after clear must re-run with the default TODO+DOING filter
    // (DONE excluded), NOT an empty array (which would route to the
    // completed-inclusive unfiltered superset, #1744).
    expect(mockedExecuteAgendaFilters).toHaveBeenLastCalledWith(
      [{ dimension: 'status', values: ['TODO', 'DOING'] }],
      null,
    )
    expect(mockedExecuteAgendaFilters).not.toHaveBeenLastCalledWith([], null)
  })

  // 10. Load more — with active filters, routes through loadMoreAgendaFilters
  //
  // Cursor-namespace fix (agenda-loadmore-cursor-namespace-2026-05-13): page 2
  // of an active-filter agenda must re-run filtered_blocks_query with the
  // saved filter payload + cursor, NOT query_by_property (whose keyset
  // namespace is incompatible with the filtered_blocks_query cursor).
  it('load more routes through loadMoreAgendaFilters when filters are active', async () => {
    // #720 — page 1 reports the `today` its date translation used; the
    // view must thread it into every load-more of the same run.
    const page1Today = new Date('2025-03-15T12:00:00')
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: true,
      cursor: 'cursor_page2',
      today: page1Today,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'true')
    })

    // Page 2 comes from the filtered helper — same IPC that minted the cursor.
    mockedLoadMoreAgendaFilters.mockResolvedValueOnce({
      blocks: [makeBlock({ id: 'B2' })],
      hasMore: false,
      cursor: null,
    })

    loadMoreRef.current?.()

    await waitFor(() => {
      // Default agenda filters (TODO + DOING) are forwarded so the backend
      // continues the AND-intersection, along with page 1's `today` (#720).
      expect(mockedLoadMoreAgendaFilters).toHaveBeenCalledWith(
        [{ dimension: 'status', values: ['TODO', 'DOING'] }],
        'cursor_page2',
        null,
        page1Today,
      )
    })

    // Critically: queryByProperty must NOT be touched when filters are active.
    expect(mockedQueryByProperty).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '2')
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'false')
    })
  })

  // 10b. Load more — no filters routes through loadMoreUnfilteredAgenda,
  // which resumes the merged due/scheduled/undated windows from the
  // composite cursor minted by executeAgendaFilters (#721).
  it('load more routes through loadMoreUnfilteredAgenda when no filters are active', async () => {
    // First mount with the default TODO+DOING filter, then have the user
    // remove every filter chip (builder emits []) so the unfiltered branch
    // is exercised on load-more. #1744 — "Clear filters" no longer empties
    // the filter (it restores the default), so the only path into the
    // no-filter branch is the filter builder emptying out.
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: true,
      cursor: 'agenda-unfiltered:{"due":"DUE_C2"}',
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'true')
    })

    // User clears all filter chips via the filter builder → empty filters →
    // no-filter (unfiltered superset) branch.
    filterChangeRef.current?.([])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '0')
    })

    mockedLoadMoreUnfilteredAgenda.mockResolvedValueOnce({
      blocks: [makeBlock({ id: 'B2' })],
      hasMore: false,
      cursor: null,
    })

    loadMoreRef.current?.()

    await waitFor(() => {
      expect(mockedLoadMoreUnfilteredAgenda).toHaveBeenCalledWith(
        'agenda-unfiltered:{"due":"DUE_C2"}',
        null,
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '2')
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'false')
    })

    // The filtered helper is NOT used on the no-filter branch, and the
    // legacy todo_state queryByProperty fallback is gone entirely.
    expect(mockedLoadMoreAgendaFilters).not.toHaveBeenCalled()
    expect(mockedQueryByProperty).not.toHaveBeenCalled()
  })

  // 11. Sort/group controls pass through to AgendaResults
  it('passes default sort/group values to results', async () => {
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    // Default values from useAgendaPreferences (localStorage empty → 'page' / 'state')
    expect(screen.getByTestId('agenda-sort-group-controls')).toHaveAttribute(
      'data-group-by',
      'page',
    )
    expect(screen.getByTestId('agenda-sort-group-controls')).toHaveAttribute(
      'data-sort-by',
      'state',
    )
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-group-by', 'page')
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-sort-by', 'state')
  })

  // 12. Container has correct data-testid and class
  it('has agenda-view container', async () => {
    render(<AgendaView />)

    expect(screen.getByTestId('agenda-view')).toBeInTheDocument()
  })

  // UX-196: default filter hides DONE tasks by restricting status to TODO+DOING
  it('UX-196: mounts with default status filter (TODO + DOING)', async () => {
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    // One default filter pill should be present on first render.
    expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '1')
    // #1744 — the untouched default is NOT considered "actively filtered":
    // an empty default agenda should show "No tasks", not "No matches" +
    // a Clear that would reset to the very same default.
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-active-filters', 'false')

    // The backend query should be called with the active-states filter,
    // not an empty array (which would include DONE). FEAT-3 Phase 4
    // adds `spaceId` (null here, no seeded space).
    expect(mockedExecuteAgendaFilters).toHaveBeenCalledWith(
      [{ dimension: 'status', values: ['TODO', 'DOING'] }],
      null,
    )
    // Explicitly: the default must NOT be an empty filter array.
    expect(mockedExecuteAgendaFilters).not.toHaveBeenCalledWith([], null)
  })

  // 13. hasMore passed to AgendaResults
  it('passes hasMore to AgendaResults', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock()],
      hasMore: true,
      cursor: 'some_cursor',
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'true')
    })
  })

  // 14. #721 — no silent client-side truncation: every fetch path is
  // backend-windowed, so a hard 200-slice would drop rows the cursor
  // had already moved past (unrecoverable for the user).
  it('#721: renders every fetched block without a 200-cap', async () => {
    const manyBlocks = Array.from({ length: 250 }, (_, i) =>
      makeBlock({ id: `B${i}`, parent_id: `P${i % 10}`, page_id: `P${i % 10}` }),
    )
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: manyBlocks,
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '250')
    })
  })

  // A11y: no violations
  it('a11y: no violations', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: false,
      cursor: null,
    })

    const { container } = render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // UX-198: AgendaView's filter/sort header is now hoisted to the App-level
  // outlet via <ViewHeader>, so the per-view wrapper no longer uses sticky
  // positioning. The header content must still render (via the ViewHeader
  // inline fallback used in isolated tests), but there must be no element
  // with the old `sticky top-0` classes on this component's subtree.
  it('UX-198: no sticky top-0 on the header wrapper', async () => {
    const { container } = render(<AgendaView />)
    await waitFor(() => {
      expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
    })
    // Header children still render.
    expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
    expect(screen.getByTestId('agenda-sort-group-controls')).toBeInTheDocument()
    // But nothing in the subtree has the old sticky-positioning classes.
    const sticky = container.querySelector('.sticky.top-0')
    expect(sticky).toBeNull()
  })
})
