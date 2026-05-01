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
 * 10. Load more calls queryByProperty with cursor
 * 11. Sort/group controls pass through to AgendaResults
 * 12. A11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock agenda-filters ─────────────────────────────────────────────
vi.mock('../../../lib/agenda-filters', () => ({
  executeAgendaFilters: vi.fn(),
}))

// ── Mock tauri lib ──────────────────────────────────────────────────
vi.mock('../../../lib/tauri', () => ({
  batchResolve: vi.fn(),
  queryByProperty: vi.fn(),
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

vi.mock('../../AgendaFilterBuilder', () => ({
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
const { clearFiltersRef, loadMoreRef } = vi.hoisted(() => ({
  clearFiltersRef: { current: null as (() => void) | null },
  loadMoreRef: { current: null as (() => void) | null },
}))

vi.mock('../../AgendaResults', () => ({
  AgendaResults: (props: {
    blocks: unknown[]
    loading: boolean
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
    return (
      <div
        data-testid="agenda-results"
        data-block-count={Array.isArray(props.blocks) ? props.blocks.length : 0}
        data-loading={String(props.loading)}
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

import { makeBlock as _makeBlock } from '../../../__tests__/fixtures'
import { executeAgendaFilters } from '../../../lib/agenda-filters'
import { batchResolve, queryByProperty } from '../../../lib/tauri'
import { AgendaView } from '../AgendaView'

const mockedExecuteAgendaFilters = vi.mocked(executeAgendaFilters)
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

  // 9. Clear filters resets to empty filter array
  it('clearing filters resets to empty array', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-loading', 'false')
    })

    // First add a filter
    filterChangeRef.current?.([{ dimension: 'status', values: ['TODO'] }])

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute(
        'data-has-active-filters',
        'true',
      )
    })

    // Now clear filters via AgendaResults callback
    mockedExecuteAgendaFilters.mockResolvedValueOnce({
      blocks: [],
      hasMore: false,
      cursor: null,
    })

    clearFiltersRef.current?.()

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute(
        'data-has-active-filters',
        'false',
      )
      expect(screen.getByTestId('agenda-filter-builder')).toHaveAttribute('data-filter-count', '0')
    })
  })

  // 10. Load more calls queryByProperty with cursor
  it('load more fetches next page', async () => {
    mockedExecuteAgendaFilters.mockResolvedValue({
      blocks: [makeBlock({ id: 'B1' })],
      hasMore: true,
      cursor: 'cursor_page2',
    })

    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'true')
    })

    // Simulate load more
    mockedQueryByProperty.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B2' })],
      next_cursor: null,
      has_more: false,
    })

    loadMoreRef.current?.()

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalledWith({
        key: 'todo_state',
        cursor: 'cursor_page2',
        limit: 200,
        // FEAT-3 Phase 4 — `currentSpaceId` is null in this fixture; the
        // wrapper forwards it as the optional `spaceId`.
        spaceId: null,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '2')
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-more', 'false')
    })
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
    expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-has-active-filters', 'true')

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

  // 14. Blocks capped at 200
  it('caps displayed blocks at 200', async () => {
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
      expect(screen.getByTestId('agenda-results')).toHaveAttribute('data-block-count', '200')
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
