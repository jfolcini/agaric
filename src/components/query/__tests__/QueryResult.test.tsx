import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'
import { detectColumns, QueryResult } from '@/components/query/QueryResult'
import { encodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { buildFilters, parseQueryExpression } from '@/lib/query-utils'
import { useNavigationStore } from '@/stores/navigation'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/components/dialogs/QueryBuilderModal', () => ({
  QueryBuilderModal: ({
    open,
    onOpenChange,
    initialExpression,
    onSave,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    initialExpression?: string
    onSave: (expression: string) => void
  }) =>
    open ? (
      <div data-testid="query-builder-modal">
        <span data-testid="modal-initial-expression">{initialExpression}</span>
        <button
          type="button"
          data-testid="modal-save-button"
          onClick={() => onSave('type:tag expr:updated')}
        >
          Save
        </button>
        <button type="button" data-testid="modal-cancel-button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
      </div>
    ) : null,
}))
const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
})

describe('parseQueryExpression', () => {
  it('parses tag query', () => {
    expect(parseQueryExpression('type:tag expr:project')).toEqual({
      type: 'tag',
      params: { type: 'tag', expr: 'project' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('parses property query', () => {
    expect(parseQueryExpression('type:property key:priority value:1')).toEqual({
      type: 'property',
      params: { type: 'property', key: 'priority', value: '1' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('returns unknown for missing type', () => {
    expect(parseQueryExpression('foo:bar')).toEqual({
      type: 'unknown',
      params: { foo: 'bar' },
      propertyFilters: [],
      tagFilters: [],
    })
  })

  it('parses single property shorthand', () => {
    expect(parseQueryExpression('property:todo_state=TODO')).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: [],
    })
  })

  it('parses multiple property shorthands (AND)', () => {
    const result = parseQueryExpression('property:todo_state=TODO property:priority=1')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [
        { key: 'todo_state', value: 'TODO', operator: 'eq' },
        { key: 'priority', value: '1', operator: 'eq' },
      ],
      tagFilters: [],
    })
  })

  it('parses tag shorthand', () => {
    expect(parseQueryExpression('tag:project-x')).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [],
      tagFilters: ['project-x'],
    })
  })

  it('parses tag + property combination', () => {
    const result = parseQueryExpression('tag:project-x property:todo_state=TODO')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: ['project-x'],
    })
  })

  it('preserves extra params alongside shorthand filters', () => {
    const result = parseQueryExpression('property:todo_state=TODO table:true')
    expect(result).toEqual({
      type: 'filtered',
      params: { table: 'true' },
      propertyFilters: [{ key: 'todo_state', value: 'TODO', operator: 'eq' }],
      tagFilters: [],
    })
  })
})

describe('QueryResult', () => {
  it('renders loading state', () => {
    mockedInvoke.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<QueryResult expression="type:tag expr:project" />)
    expect(screen.getByText('...')).toBeInTheDocument()
    // Spinner component should render via shared Spinner
    expect(container.querySelector('[data-slot="spinner"]')).toBeInTheDocument()
  })

  it('renders tag query results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Task under project',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              todo_state: 'TODO',
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: 'P1',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Project Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText(/Task under project/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()
  })

  it('renders empty state when no results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return { rows: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:nonexistent" />)

    // EmptyState component renders with i18n key query.noResults
    expect(await screen.findByText('No results')).toBeInTheDocument()
    expect(screen.getByText('0 results')).toBeInTheDocument()
    // Verify EmptyState is used (renders an h2 heading)
    expect(screen.getByRole('heading', { level: 2, name: 'No results' })).toBeInTheDocument()
  })

  it('renders error for unknown query type', async () => {
    render(<QueryResult expression="type:invalid" />)

    expect(await screen.findByText(/Unknown query type/)).toBeInTheDocument()
  })

  it('collapses and expands results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Result',
              parent_id: null,
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: null,
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      return {}
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:test" />)

    await screen.findByText(/Result/)

    // Click header to collapse
    const header = screen.getByTitle('type:tag expr:test').closest('button') as HTMLElement
    await user.click(header)

    expect(screen.queryByText(/Result/)).not.toBeInTheDocument()

    // Click again to expand
    await user.click(header)
    expect(await screen.findByText(/Result/)).toBeInTheDocument()
  })

  it('navigates when clicking a result item', async () => {
    const onNavigate = vi.fn()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Click me',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: 'P1',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:test" onNavigate={onNavigate} />)

    const item = await screen.findByText(/Click me/)
    await user.click(item.closest('[role="option"]') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('renders property query results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'High priority task',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              todo_state: 'TODO',
              priority: '1',
              due_date: null,
              scheduled_date: null,
              page_id: 'P1',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="type:property key:priority value:1" />)
    expect(await screen.findByText(/High priority task/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()
  })

  it('shows error for property query without key', async () => {
    render(<QueryResult expression="type:property value:1" />)
    expect(await screen.findByText(/requires key/)).toBeInTheDocument()
  })

  it('shows error for backlinks query without target', async () => {
    render(<QueryResult expression="type:backlinks" />)
    expect(await screen.findByText(/requires target/)).toBeInTheDocument()
  })

  it('shows error for empty expression', async () => {
    render(<QueryResult expression="" />)
    expect(await screen.findByText(/empty/i)).toBeInTheDocument()
  })

  it('renders backlinks query results', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Child block',
              parent_id: 'TARGET1',
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: 'TARGET1',
            },
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="type:backlinks target:TARGET1" />)
    expect(await screen.findByText(/Child block/)).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Accessible',
              parent_id: null,
              position: 1,
              deleted_at: null,
              todo_state: 'TODO',
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: null,
            },
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return {}
    })

    const { container } = render(<QueryResult expression="type:tag expr:test" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // Error path renders a Retry button that re-fetches results
  it('renders a Retry button alongside the error message', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') throw new Error('boom')
      return {}
    })

    render(<QueryResult expression="type:tag expr:test" />)

    const retryBtn = await screen.findByRole('button', { name: 'Retry' })
    expect(retryBtn).toBeInTheDocument()
    // Error region is announced as an alert
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('Retry button re-invokes the query on click', async () => {
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        callCount++
        if (callCount === 1) throw new Error('first failure')
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Recovered',
              parent_id: null,
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: null,
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return {}
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:test" />)

    const retryBtn = await screen.findByRole('button', { name: 'Retry' })
    await user.click(retryBtn)

    expect(await screen.findByText(/Recovered/)).toBeInTheDocument()
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('error region with Retry button has no a11y violations', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') throw new Error('boom')
      return {}
    })

    const { container } = render(<QueryResult expression="type:tag expr:test" />)

    await screen.findByRole('button', { name: 'Retry' })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // PageLink breadcrumb navigation
  it('clicking page title in breadcrumb navigates to the page via PageLink', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Result with breadcrumb',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: 'P1',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Resolved Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:test" />)

    // Wait for the page title to appear as a link (PageLink)
    const pageLink = await screen.findByRole('link', { name: 'Resolved Page' })
    await user.click(pageLink)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
    expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('P1')
    expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('Resolved Page')
  })
})

/* ------------------------------------------------------------------ */
/*  Table-mode tests                                                  */
/* ------------------------------------------------------------------ */

describe('detectColumns', () => {
  // DetectColumns now always returns Content + every known
  // property column regardless of whether the data populates them.
  // Missing values are rendered as `—` placeholders in QueryResultTable.
  it('returns all known columns even when no properties are set', () => {
    const blocks = [
      {
        id: 'B1',
        block_type: 'content',
        content: 'Hello',
        parent_id: null,
        position: 1,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: null,
      },
    ]
    const cols = detectColumns(blocks)
    expect(cols.map((c) => c.key)).toEqual([
      'content',
      'todo_state',
      'priority',
      'due_date',
      'scheduled_date',
    ])
  })

  it('returns the same columns when properties are populated', () => {
    const blocks = [
      {
        id: 'B1',
        block_type: 'content',
        content: 'Task',
        parent_id: null,
        position: 1,
        deleted_at: null,
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-01-01',
        scheduled_date: null,
        page_id: null,
      },
    ]
    const cols = detectColumns(blocks)
    expect(cols.map((c) => c.key)).toEqual([
      'content',
      'todo_state',
      'priority',
      'due_date',
      'scheduled_date',
    ])
  })

  it('returns all known columns for an empty result set', () => {
    const cols = detectColumns([])
    expect(cols.map((c) => c.key)).toEqual([
      'content',
      'todo_state',
      'priority',
      'due_date',
      'scheduled_date',
    ])
  })
})

describe('QueryResult – table mode', () => {
  const TABLE_EXPRESSION = 'type:tag expr:project table:true'

  function mockTagResults(items: ReturnType<typeof makeBlock>[]) {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      // `type:tag` reroutes through the rich `run_advanced_query` engine
      // (P2). The tag-prefix resolution IPC returns no exact matches; the
      // rows below are what the rich engine yields for this query.
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return { rows: items, nextCursor: null, hasMore: false, totalCount: null }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Project Page', block_type: 'page', deleted: false }]
      }
      return null
    })
  }

  it('renders as list by default (no table:true)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({
              id: 'B1',
              content: 'Task A',
              parent_id: 'P1',
              page_id: 'P1',
              todo_state: 'TODO',
            }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    // Should render a list, not a table
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('renders as table when table:true in query params', async () => {
    mockTagResults([
      makeBlock({
        id: 'B1',
        content: 'Task A',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'TODO',
      }),
    ])

    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    // Should NOT have a list
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('table has correct columns from block properties', async () => {
    mockTagResults([
      makeBlock({
        id: 'B1',
        content: 'Task A',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-06-01',
      }),
      makeBlock({
        id: 'B2',
        content: 'Task B',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'DONE',
        priority: '2',
        due_date: null,
      }),
    ])

    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    // Check column headers
    const table = screen.getByRole('table')
    expect(within(table).getByText('Content')).toBeInTheDocument()
    expect(within(table).getByText('Status')).toBeInTheDocument()
    expect(within(table).getByText('Priority')).toBeInTheDocument()
    expect(within(table).getByText('Due Date')).toBeInTheDocument()
    expect(within(table).getByText('Page')).toBeInTheDocument()

    // Check data rows
    expect(within(table).getByText(/Task A/)).toBeInTheDocument()
    expect(within(table).getByText(/Task B/)).toBeInTheDocument()
    expect(within(table).getByText('TODO')).toBeInTheDocument()
    expect(within(table).getByText('DONE')).toBeInTheDocument()
  })

  it('clicking column header sorts results', async () => {
    mockTagResults([
      makeBlock({
        id: 'B1',
        content: 'Beta task',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'TODO',
      }),
      makeBlock({
        id: 'B2',
        content: 'Alpha task',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'DONE',
      }),
    ])

    const user = userEvent.setup()
    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    const contentHeader = screen.getByText('Content')

    // Click to sort ascending by Content
    await user.click(contentHeader)

    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    // rows[0] is header, rows[1..] are data
    const firstDataRow = rows[1]
    const secondDataRow = rows[2]

    expect(within(firstDataRow as HTMLElement).getByText(/Alpha task/)).toBeInTheDocument()
    expect(within(secondDataRow as HTMLElement).getByText(/Beta task/)).toBeInTheDocument()

    // Verify aria-sort is set
    expect(contentHeader.closest('th')).toHaveAttribute('aria-sort', 'ascending')

    // Click again to sort descending
    await user.click(contentHeader)

    expect(contentHeader.closest('th')).toHaveAttribute('aria-sort', 'descending')

    const rowsAfter = within(table).getAllByRole('row')
    expect(within(rowsAfter[1] as HTMLElement).getByText(/Beta task/)).toBeInTheDocument()
    expect(within(rowsAfter[2] as HTMLElement).getByText(/Alpha task/)).toBeInTheDocument()
  })

  it('table content cells are clickable and navigate', async () => {
    const onNavigate = vi.fn()
    mockTagResults([
      makeBlock({
        id: 'B1',
        content: 'Navigate me',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'TODO',
      }),
    ])

    const user = userEvent.setup()
    render(<QueryResult expression={TABLE_EXPRESSION} onNavigate={onNavigate} />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    const link = screen.getByText(/Navigate me/)
    await user.click(link.closest('button') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('axe a11y for table mode', async () => {
    mockTagResults([
      makeBlock({
        id: 'B1',
        content: 'Accessible task',
        parent_id: 'P1',
        page_id: 'P1',
        todo_state: 'TODO',
        priority: '1',
      }),
    ])

    const { container } = render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

/* ------------------------------------------------------------------ */
/*  buildFilters tests                                                */
/* ------------------------------------------------------------------ */

describe('buildFilters', () => {
  it('maps todo_state to TodoState filter', () => {
    const filters = buildFilters([{ key: 'todo_state', value: 'TODO' }], [])
    expect(filters).toEqual([{ type: 'TodoState', state: 'TODO' }])
  })

  it('maps priority to Priority filter', () => {
    const filters = buildFilters([{ key: 'priority', value: '1' }], [])
    expect(filters).toEqual([{ type: 'Priority', level: '1' }])
  })

  it('maps due_date to DueDate Eq filter', () => {
    const filters = buildFilters([{ key: 'due_date', value: '2025-01-01' }], [])
    expect(filters).toEqual([{ type: 'DueDate', op: 'Eq', value: '2025-01-01' }])
  })

  it('maps custom property key to PropertyText filter', () => {
    const filters = buildFilters([{ key: 'status', value: 'active' }], [])
    expect(filters).toEqual([{ type: 'PropertyText', key: 'status', op: 'Eq', value: 'active' }])
  })

  it('maps tag filters to HasTagPrefix', () => {
    const filters = buildFilters([], ['project-x'])
    expect(filters).toEqual([{ type: 'HasTagPrefix', prefix: 'project-x' }])
  })

  it('combines multiple property and tag filters', () => {
    const filters = buildFilters(
      [
        { key: 'todo_state', value: 'TODO' },
        { key: 'priority', value: '1' },
      ],
      ['project-x'],
    )
    expect(filters).toEqual([
      { type: 'TodoState', state: 'TODO' },
      { type: 'Priority', level: '1' },
      { type: 'HasTagPrefix', prefix: 'project-x' },
    ])
  })

  it('returns empty array when no filters', () => {
    expect(buildFilters([], [])).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/*  Multi-filter (filtered type) rendering tests                      */
/* ------------------------------------------------------------------ */

describe('QueryResult – multi-filter (filtered)', () => {
  // Shorthand `property:key=value` and `tag:prefix` syntax (and their AND
  // combinations) now reroute through the rich `run_advanced_query` engine
  // (P2). The parsed `type: 'filtered'` shape is translated to a single
  // `And` `FilterExpr`; the legacy `filtered_blocks_query` IPC no longer
  // fires for faithfully-translatable shapes.
  it('single property shorthand filter dispatches to run_advanced_query', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({
              id: 'B1',
              content: 'TODO task',
              parent_id: 'P1',
              page_id: 'P1',
              todo_state: 'TODO',
            }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText(/TODO task/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // Verify run_advanced_query was called exactly once with an `And`
    // FilterExpr whose only child is the `State` row-column predicate.
    const advCalls = mockedInvoke.mock.calls.filter((c) => c[0] === 'run_advanced_query')
    expect(advCalls).toHaveLength(1)
    expect(mockedInvoke).toHaveBeenCalledWith(
      'run_advanced_query',
      expect.objectContaining({
        request: expect.objectContaining({
          filter: expect.objectContaining({
            type: 'And',
            children: [
              {
                type: 'Leaf',
                primitive: expect.objectContaining({ type: 'State', values: ['TODO'] }),
              },
            ],
          }),
        }),
      }),
    )
  })

  it('multiple property filters produce AND semantics', async () => {
    // AND-intersection is now SQL-side via the rich engine. The mock
    // returns the post-intersection result set directly; there is no
    // per-sub-filter fan-out to model.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({
              id: 'B1',
              content: 'High-pri TODO',
              parent_id: 'P1',
              page_id: 'P1',
              todo_state: 'TODO',
              priority: '1',
            }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO property:priority=1" />)

    // Only the post-intersection row appears.
    expect(await screen.findByText(/High-pri TODO/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // Both property filters are forwarded in a single IPC as an `And` of
    // the two row-column predicates.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'run_advanced_query',
      expect.objectContaining({
        request: expect.objectContaining({
          filter: expect.objectContaining({
            type: 'And',
            children: [
              {
                type: 'Leaf',
                primitive: expect.objectContaining({ type: 'State', values: ['TODO'] }),
              },
              {
                type: 'Leaf',
                primitive: expect.objectContaining({ type: 'Priority', values: ['1'] }),
              },
            ],
          }),
        }),
      }),
    )
  })

  it('tag + property combination dispatches a single run_advanced_query', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_PX', name: 'project-x', usage_count: 3, updated_at: '2025-01-01' }]
      }
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({
              id: 'B1',
              content: 'Tagged TODO',
              parent_id: 'P1',
              page_id: 'P1',
              todo_state: 'TODO',
            }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="tag:project-x property:todo_state=TODO" />)

    expect(await screen.findByText(/Tagged TODO/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // Both tag + property filters are forwarded in one IPC as an `And` of
    // the `State` predicate and the resolved tag `Or`.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'run_advanced_query',
      expect.objectContaining({
        request: expect.objectContaining({
          filter: expect.objectContaining({
            type: 'And',
            children: expect.arrayContaining([
              {
                type: 'Leaf',
                primitive: expect.objectContaining({ type: 'State', values: ['TODO'] }),
              },
              expect.objectContaining({
                type: 'Or',
                children: [{ type: 'Leaf', primitive: { type: 'TagOrRef', tag: 'TAG_PX' } }],
              }),
            ]),
          }),
        }),
      }),
    )
  })

  it('renders results from filtered query in table mode', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({
              id: 'B1',
              content: 'Filtered task',
              parent_id: 'P1',
              page_id: 'P1',
              todo_state: 'TODO',
              priority: '1',
            }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Test Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO table:true" />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    const table = screen.getByRole('table')
    expect(within(table).getByText(/Filtered task/)).toBeInTheDocument()
    expect(within(table).getByText('TODO')).toBeInTheDocument()
  })

  it('shows empty state when filtered query returns no rows', async () => {
    // Empty state simply means the rich engine's AND
    // intersection produced zero rows. No per-sub-filter mocking
    // needed.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return { rows: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO property:priority=1" />)

    expect(await screen.findByText('No results')).toBeInTheDocument()
    expect(screen.getByText('0 results')).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ */
/*  Error path tests (mockRejectedValueOnce)                          */
/* ------------------------------------------------------------------ */

describe('QueryResult – error paths', () => {
  it('shows error when tag query rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Tag service unavailable'))

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText('Tag service unavailable')).toBeInTheDocument()
    // Loading indicator should be gone
    expect(screen.queryByText('...')).not.toBeInTheDocument()
    // Results list should not render
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when property query rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Property lookup failed'))

    render(<QueryResult expression="type:property key:priority value:1" />)

    expect(await screen.findByText('Property lookup failed')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when backlinks query rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Backlinks fetch failed'))

    render(<QueryResult expression="type:backlinks target:TARGET1" />)

    expect(await screen.findByText('Backlinks fetch failed')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when filtered property query rejects', async () => {
    // Shorthand `property:` routes through
    // `filtered_blocks_query` (single IPC).
    mockedInvoke.mockRejectedValueOnce(new Error('Filter query broken'))

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText('Filter query broken')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when filtered_blocks_query rejects for tag+property combo', async () => {
    // Tag + property filters now collapse into a
    // single `filtered_blocks_query` IPC. A rejection of that one IPC
    // surfaces as the error message — no Promise.all fan-out exists.
    mockedInvoke.mockRejectedValueOnce(new Error('Filtered query rejected'))

    render(<QueryResult expression="tag:project-x property:todo_state=TODO" />)

    expect(await screen.findByText('Filtered query rejected')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when batchResolve rejects after successful tag query', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Result block',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
              page_id: 'P1',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') throw new Error('Batch resolve failed')
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText('Batch resolve failed')).toBeInTheDocument()
  })

  it('shows error when batchResolve rejects after successful property query', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Priority task',
              parent_id: 'P2',
              position: 1,
              deleted_at: null,
              todo_state: 'TODO',
              priority: '1',
              due_date: null,
              scheduled_date: null,
              page_id: 'P2',
            },
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') throw new Error('Resolution service down')
      return null
    })

    render(<QueryResult expression="type:property key:priority value:1" />)

    expect(await screen.findByText('Resolution service down')).toBeInTheDocument()
  })

  it('shows generic fallback for non-Error rejection', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') throw 'string error without Error wrapper'
      if (cmd === 'run_advanced_query') throw 'string error without Error wrapper'
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText('Query failed')).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------ */
/*  Pagination tests                                                  */
/* ------------------------------------------------------------------ */

describe('QueryResult – pagination', () => {
  it('load more button appears when has_more is true', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({ id: 'B1', content: 'First page item', parent_id: 'P1', page_id: 'P1' }),
          ],
          nextCursor: 'cursor1',
          hasMore: true,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText(/First page item/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
  })

  // #1743 — when more pages remain unloaded the header count is the
  // loaded-so-far count, which is NOT the true total. It must be labelled
  // as partial ("first N loaded") rather than presented as the final count
  // (which would mislead vs. the AdvancedQueryView true total).
  it('labels the count as partial when has_more is true', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({ id: 'B1', content: 'First page item', parent_id: 'P1', page_id: 'P1' }),
          ],
          nextCursor: 'cursor1',
          hasMore: true,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText(/First page item/)).toBeInTheDocument()
    // Partial label, NOT the misleading "1 result" final-count phrasing.
    expect(screen.getByText('first 1 loaded')).toBeInTheDocument()
    expect(screen.queryByText('1 result')).not.toBeInTheDocument()
  })

  it('shows the exact count (not partial) once the last page is loaded', async () => {
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        callCount++
        if (callCount === 1) {
          return {
            rows: [makeBlock({ id: 'B1', content: 'First page item', parent_id: null })],
            nextCursor: 'cursor1',
            hasMore: true,
            totalCount: null,
          }
        }
        return {
          rows: [makeBlock({ id: 'B2', content: 'Second page item', parent_id: null })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" />)

    // First page: partial label.
    expect(await screen.findByText(/First page item/)).toBeInTheDocument()
    expect(screen.getByText('first 1 loaded')).toBeInTheDocument()

    // Load the final page → count becomes exact, no longer partial.
    await user.click(screen.getByRole('button', { name: /load more/i }))
    expect(await screen.findByText(/Second page item/)).toBeInTheDocument()
    expect(screen.getByText('2 results')).toBeInTheDocument()
    expect(screen.queryByText(/first \d+ loaded/)).not.toBeInTheDocument()
  })

  it('load more button is hidden when has_more is false', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Only page', parent_id: null })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText(/Only page/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  it('clicking load more fetches next page and accumulates results', async () => {
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        callCount++
        if (callCount === 1) {
          return {
            rows: [makeBlock({ id: 'B1', content: 'First page item', parent_id: null })],
            nextCursor: 'cursor1',
            hasMore: true,
            totalCount: null,
          }
        }
        return {
          rows: [makeBlock({ id: 'B2', content: 'Second page item', parent_id: null })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText(/First page item/)).toBeInTheDocument()

    const loadMoreBtn = screen.getByRole('button', { name: /load more/i })
    await user.click(loadMoreBtn)

    expect(await screen.findByText(/Second page item/)).toBeInTheDocument()
    // First page items are still visible
    expect(screen.getByText(/First page item/)).toBeInTheDocument()
    // Load more button is gone after last page
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    // Count reflects all loaded items
    expect(screen.getByText('2 results')).toBeInTheDocument()
  })

  it('axe a11y audit with load more button', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [
            makeBlock({
              id: 'B1',
              content: 'Accessible item',
              parent_id: null,
              todo_state: 'TODO',
            }),
          ],
          next_cursor: 'cursor1',
          has_more: true,
          total_count: null,
        }
      }
      return {}
    })

    const { container } = render(<QueryResult expression="type:tag expr:test" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

/* ------------------------------------------------------------------ */
/*  Query expression pills tests                                      */
/* ------------------------------------------------------------------ */

describe('QueryResult – expression pills', () => {
  it('renders query expression as Badge pills', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    await waitFor(() => {
      // Type badge (variant="default")
      const typeBadge = screen.getByText('tag')
      expect(typeBadge).toHaveAttribute('data-slot', 'badge')
      expect(typeBadge).toHaveAttribute('data-variant', 'default')

      // Param badge (variant="secondary")
      const paramBadge = screen.getByText('expr: project')
      expect(paramBadge).toHaveAttribute('data-slot', 'badge')
      expect(paramBadge).toHaveAttribute('data-variant', 'secondary')
    })
  })

  it('renders property filter pills for filtered queries', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO" />)

    await waitFor(() => {
      // Type badge for filtered
      const typeBadge = screen.getByText('filtered')
      expect(typeBadge).toHaveAttribute('data-slot', 'badge')
      expect(typeBadge).toHaveAttribute('data-variant', 'default')

      // Property filter badge
      const filterBadge = screen.getByText('todo_state = TODO')
      expect(filterBadge).toHaveAttribute('data-slot', 'badge')
      expect(filterBadge).toHaveAttribute('data-variant', 'secondary')
    })
  })

  it('renders tag filter pills', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="tag:project-x property:todo_state=TODO" />)

    await waitFor(() => {
      const tagBadge = screen.getByText('tag: project-x')
      expect(tagBadge).toHaveAttribute('data-slot', 'badge')
      expect(tagBadge).toHaveAttribute('data-variant', 'secondary')
    })
  })

  it('raw expression is visible on hover via title attribute', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="type:tag expr:project" />)

    await waitFor(() => {
      const pillContainer = screen.getByTitle('type:tag expr:project')
      expect(pillContainer).toBeInTheDocument()
    })
  })

  it('axe a11y audit with expression pills', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Item', parent_id: null, todo_state: 'TODO' })],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return {}
    })

    const { container } = render(<QueryResult expression="type:tag expr:test" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // #1525 — a range filter on the same property key (`due>=X due<=Y`) used to
  // produce two pills keyed identically (`prop-due`), triggering React's
  // duplicate-key warning and risking mis-reconciliation. Keys now include the
  // array index + operator, so both pills coexist with no warning.
  it('renders distinct pills for a same-key property range without duplicate-key warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="property:due>=2025-01-01 property:due<=2025-12-31" />)

    await waitFor(() => {
      // Both ends of the range render as separate pills.
      expect(screen.getByText('due ≥ 2025-01-01')).toBeInTheDocument()
      expect(screen.getByText('due ≤ 2025-12-31')).toBeInTheDocument()
    })

    // No React "Encountered two children with the same key" warning emitted.
    const dupKeyWarning = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('same key')),
    )
    expect(dupKeyWarning).toBe(false)
    errorSpy.mockRestore()
  })

  // #1525 — repeated identical tags (`tag:foo tag:foo`) used to collapse to
  // identical `tag-foo` keys. Index-qualified keys keep them distinct.
  it('renders distinct pills for repeated identical tags without duplicate-key warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="tag:foo tag:foo" />)

    await waitFor(() => {
      // Both repeated tags render as separate pills.
      expect(screen.getAllByText('tag: foo')).toHaveLength(2)
    })

    const dupKeyWarning = errorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('same key')),
    )
    expect(dupKeyWarning).toBe(false)
    errorSpy.mockRestore()
  })
})

/* ------------------------------------------------------------------ */
/*  Operator syntax + relative date tests                             */
/* ------------------------------------------------------------------ */

describe('QueryResult – operator syntax', () => {
  // Shorthand `property:key{op}value` parses as `type: 'filtered'` and now
  // reroutes through the rich `run_advanced_query` engine. The reserved
  // `due_date` key with an ordered operator maps to a `DueDate` predicate;
  // the operator becomes the `DatePredicate` variant (`gt → After`,
  // `lte → OnOrBefore`, `eq → On`).
  it('forwards operator "gt" inside run_advanced_query for property:due_date>today', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return { rows: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      return null
    })

    render(<QueryResult expression="property:due_date>today" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'run_advanced_query',
        expect.objectContaining({
          request: expect.objectContaining({
            filter: expect.objectContaining({
              type: 'And',
              children: [
                {
                  type: 'Leaf',
                  primitive: {
                    type: 'DueDate',
                    predicate: expect.objectContaining({ type: 'After' }),
                  },
                },
              ],
            }),
          }),
        }),
      )
    })

    // Verify "today" was resolved to an ISO date string in the predicate.
    const call = mockedInvoke.mock.calls.find((c) => c[0] === 'run_advanced_query')
    const args = call?.[1] as { request: { filter: { children: Array<Record<string, unknown>> } } }
    const leaf = args.request.filter.children[0] as {
      primitive: { predicate: Record<string, unknown> }
    }
    expect(leaf.primitive.predicate['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('forwards operator "lte" inside run_advanced_query for property:due_date<=2025-12-31', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return { rows: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      return null
    })

    render(<QueryResult expression="property:due_date<=2025-12-31" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'run_advanced_query',
        expect.objectContaining({
          request: expect.objectContaining({
            filter: expect.objectContaining({
              type: 'And',
              children: [
                {
                  type: 'Leaf',
                  primitive: {
                    type: 'DueDate',
                    predicate: { type: 'OnOrBefore', date: '2025-12-31' },
                  },
                },
              ],
            }),
          }),
        }),
      )
    })
  })

  it('backward compatible: property:key=value still works with operator "eq"', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return {
          rows: [
            makeBlock({ id: 'B1', content: 'Eq result', parent_id: null, todo_state: 'TODO' }),
          ],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText(/Eq result/)).toBeInTheDocument()

    // The reserved `todo_state` eq filter maps to a `State` set-membership
    // predicate carried inside the rich engine's `And` FilterExpr.
    expect(mockedInvoke).toHaveBeenCalledWith(
      'run_advanced_query',
      expect.objectContaining({
        request: expect.objectContaining({
          filter: expect.objectContaining({
            type: 'And',
            children: [
              {
                type: 'Leaf',
                primitive: expect.objectContaining({ type: 'State', values: ['TODO'] }),
              },
            ],
          }),
        }),
      }),
    )
  })

  it('resolves relative date "today" to ISO date string', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_advanced_query') {
        return { rows: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      return null
    })

    render(<QueryResult expression="property:due_date>today" />)

    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find((c) => c[0] === 'run_advanced_query')
      expect(call).toBeDefined()
      const args = call?.[1] as {
        request: {
          filter: { children: Array<{ primitive: { predicate: Record<string, unknown> } }> }
        }
      }
      const predicate = args.request.filter.children[0]?.primitive.predicate as Record<
        string,
        unknown
      >
      // "today" should be resolved to an ISO date (YYYY-MM-DD) on the predicate.
      expect(predicate['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('pills display operator symbol for gt', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="property:due_date>today" />)

    await waitFor(() => {
      const pill = screen.getByText('due_date > today')
      expect(pill).toHaveAttribute('data-slot', 'badge')
    })
  })

  it('pills display ≤ symbol for lte operator', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="property:due_date<=2025-12-31" />)

    await waitFor(() => {
      const pill = screen.getByText('due_date ≤ 2025-12-31')
      expect(pill).toHaveAttribute('data-slot', 'badge')
    })
  })

  it('pills display ≠ symbol for neq operator', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'filtered_blocks_query') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })

    render(<QueryResult expression="property:status!=done" />)

    await waitFor(() => {
      const pill = screen.getByText('status ≠ done')
      expect(pill).toHaveAttribute('data-slot', 'badge')
    })
  })
})

/* ------------------------------------------------------------------ */
/*  Edit Query button + QueryBuilderModal integration tests           */
/* ------------------------------------------------------------------ */

describe('QueryResult – Edit Query button', () => {
  const mockedToastError = vi.mocked(toast.error)

  function mockEmptyTagResults() {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      return null
    })
  }

  function mockTagResultsWithBlock() {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_tags_by_prefix') return []
      if (cmd === 'run_advanced_query') {
        return {
          rows: [makeBlock({ id: 'B1', content: 'Result item', parent_id: 'P1', page_id: 'P1' })],
          nextCursor: null,
          hasMore: false,
          totalCount: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Page', block_type: 'page', deleted: false }]
      }
      if (cmd === 'edit_block') {
        return makeBlock({ id: 'BLOCK1', content: '{{query type:tag expr:updated}}' })
      }
      return null
    })
  }

  it('shows edit button when blockId is provided', async () => {
    mockEmptyTagResults()

    render(<QueryResult expression="type:tag expr:project" blockId="BLOCK1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit query' })).toBeInTheDocument()
    })
  })

  it('does not show edit button when blockId is not provided', async () => {
    mockEmptyTagResults()

    render(<QueryResult expression="type:tag expr:project" />)

    await waitFor(() => {
      expect(screen.getByText('0 results')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Edit query' })).not.toBeInTheDocument()
  })

  it('opens QueryBuilderModal when edit button clicked', async () => {
    mockEmptyTagResults()

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" blockId="BLOCK1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit query' })).toBeInTheDocument()
    })

    // Modal should not be open initially
    expect(screen.queryByTestId('query-builder-modal')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit query' }))

    // Modal should now be open with the initial expression
    expect(screen.getByTestId('query-builder-modal')).toBeInTheDocument()
    expect(screen.getByTestId('modal-initial-expression')).toHaveTextContent(
      'type:tag expr:project',
    )
  })

  it('does not toggle collapse when edit button is clicked', async () => {
    mockTagResultsWithBlock()

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" blockId="BLOCK1" />)

    // Wait for results to render
    expect(await screen.findByText(/Result item/)).toBeInTheDocument()

    // Click the edit button
    await user.click(screen.getByRole('button', { name: 'Edit query' }))

    // Results should still be visible (not collapsed)
    expect(screen.getByText(/Result item/)).toBeInTheDocument()
  })

  it('calls editBlock when saving from modal', async () => {
    mockTagResultsWithBlock()

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" blockId="BLOCK1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit query' })).toBeInTheDocument()
    })

    // Open the modal
    await user.click(screen.getByRole('button', { name: 'Edit query' }))
    expect(screen.getByTestId('query-builder-modal')).toBeInTheDocument()

    // Click save
    await user.click(screen.getByTestId('modal-save-button'))

    // Verify editBlock was called with correct arguments
    expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
      blockId: 'BLOCK1',
      toText: '{{query type:tag expr:updated}}',
    })

    // Modal should close after save
    await waitFor(() => {
      expect(screen.queryByTestId('query-builder-modal')).not.toBeInTheDocument()
    })
  })

  it('shows toast error when editBlock fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      }
      if (cmd === 'edit_block') {
        throw new Error('Backend error')
      }
      return null
    })

    const user = userEvent.setup()
    render(<QueryResult expression="type:tag expr:project" blockId="BLOCK1" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit query' })).toBeInTheDocument()
    })

    // Open modal and save
    await user.click(screen.getByRole('button', { name: 'Edit query' }))
    await user.click(screen.getByTestId('modal-save-button'))

    // Toast error should be shown
    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update query')
    })

    // Modal should remain open on error
    expect(screen.getByTestId('query-builder-modal')).toBeInTheDocument()
  })

  it('does not render modal when blockId is not provided', async () => {
    mockEmptyTagResults()

    render(<QueryResult expression="type:tag expr:project" />)

    await waitFor(() => {
      expect(screen.getByText('0 results')).toBeInTheDocument()
    })

    // Modal element should not exist in DOM at all
    expect(screen.queryByTestId('query-builder-modal')).not.toBeInTheDocument()
  })

  it('axe a11y with edit button', async () => {
    mockEmptyTagResults()

    const { container } = render(
      <QueryResult expression="type:tag expr:project" blockId="BLOCK1" />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  describe('structured (v2) inline queries', () => {
    it('renders an advanced-query badge and runs the rich engine', async () => {
      const expression = encodeInlineQueryPayload({
        filter: {
          type: 'Or',
          children: [
            { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
            { type: 'Leaf', primitive: { type: 'Tag', tag: 'T1' } },
          ],
        },
        table: false,
      })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'run_advanced_query') {
          return {
            rows: [makeBlock({ id: 'B1', content: 'Rich row', parent_id: 'P1', page_id: 'P1' })],
            nextCursor: null,
            hasMore: false,
            totalCount: 1,
          }
        }
        if (cmd === 'batch_resolve') {
          return [{ id: 'P1', title: 'Page', block_type: 'page', deleted: false }]
        }
        return null
      })

      render(<QueryResult expression={expression} />)

      // The opaque base64 payload renders as a labelled "Advanced query" badge,
      // not as raw legacy pills.
      expect(await screen.findByText(/advanced query · 2 conditions/i)).toBeInTheDocument()
      expect(await screen.findByText('Rich row')).toBeInTheDocument()
      // The rich engine ran; no legacy tag/property IPC fired.
      const cmds = mockedInvoke.mock.calls.map((c) => c[0])
      expect(cmds).toContain('run_advanced_query')
      expect(cmds).not.toContain('query_by_tags')
    })

    it('honours the table flag from the decoded v2 spec', async () => {
      const expression = encodeInlineQueryPayload({
        filter: { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
        table: true,
      })
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'run_advanced_query') {
          return {
            rows: [makeBlock({ id: 'B1', content: 'Cell', parent_id: 'P1', page_id: 'P1' })],
            nextCursor: null,
            hasMore: false,
            totalCount: 1,
          }
        }
        if (cmd === 'batch_resolve') return []
        return null
      })

      render(<QueryResult expression={expression} />)
      // Table mode renders a table rather than the list.
      expect(await screen.findByRole('table')).toBeInTheDocument()
    })
  })
})
