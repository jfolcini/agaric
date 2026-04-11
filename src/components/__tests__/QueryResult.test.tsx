import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { buildFilters, detectColumns, parseQueryExpression, QueryResult } from '../QueryResult'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../QueryBuilderModal', () => ({
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
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
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
      if (cmd === 'query_by_tags') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Task under project',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
              todo_state: 'TODO',
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false }
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
      if (cmd === 'query_by_tags') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Result',
              parent_id: null,
              position: 1,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
      if (cmd === 'query_by_tags') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Click me',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
      if (cmd === 'query_by_property') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'High priority task',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
              todo_state: 'TODO',
              priority: '1',
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
              is_conflict: false,
              conflict_type: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
              is_conflict: false,
              conflict_type: null,
              todo_state: 'TODO',
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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

  // PageLink breadcrumb navigation
  it('clicking page title in breadcrumb navigates to the page via PageLink', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [
            {
              id: 'B1',
              block_type: 'content',
              content: 'Result with breadcrumb',
              parent_id: 'P1',
              position: 1,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
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
    expect(selectPageStack(navState)).toHaveLength(1)
    expect(selectPageStack(navState)[0]?.pageId).toBe('P1')
    expect(selectPageStack(navState)[0]?.title).toBe('Resolved Page')
  })
})

/* ------------------------------------------------------------------ */
/*  Table-mode tests                                                  */
/* ------------------------------------------------------------------ */

describe('detectColumns', () => {
  it('returns only Content when no properties set', () => {
    const blocks = [
      {
        id: 'B1',
        block_type: 'content',
        content: 'Hello',
        parent_id: null,
        position: 1,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
    ]
    const cols = detectColumns(blocks)
    expect(cols).toEqual([{ key: 'content', label: 'Content' }])
  })

  it('includes columns for populated properties', () => {
    const blocks = [
      {
        id: 'B1',
        block_type: 'content',
        content: 'Task',
        parent_id: null,
        position: 1,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-01-01',
        scheduled_date: null,
      },
    ]
    const cols = detectColumns(blocks)
    expect(cols.map((c) => c.key)).toEqual(['content', 'todo_state', 'priority', 'due_date'])
  })
})

describe('QueryResult – table mode', () => {
  const TABLE_EXPRESSION = 'type:tag expr:project table:true'

  function mockTagResults(items: ReturnType<typeof makeBlock>[]) {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items, next_cursor: null, has_more: false }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Project Page', block_type: 'page', deleted: false }]
      }
      return null
    })
  }

  it('renders as list by default (no table:true)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Task A', parent_id: 'P1', todo_state: 'TODO' })],
          next_cursor: null,
          has_more: false,
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
      makeBlock({ id: 'B1', content: 'Task A', parent_id: 'P1', todo_state: 'TODO' }),
    ])

    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
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
        todo_state: 'TODO',
        priority: '1',
        due_date: '2025-06-01',
      }),
      makeBlock({
        id: 'B2',
        content: 'Task B',
        parent_id: 'P1',
        todo_state: 'DONE',
        priority: '2',
        due_date: null,
      }),
    ])

    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })

    // Check column headers
    const table = screen.getByRole('grid')
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
      makeBlock({ id: 'B1', content: 'Beta task', parent_id: 'P1', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'Alpha task', parent_id: 'P1', todo_state: 'DONE' }),
    ])

    const user = userEvent.setup()
    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })

    const contentHeader = screen.getByText('Content')

    // Click to sort ascending by Content
    await user.click(contentHeader)

    const table = screen.getByRole('grid')
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
      makeBlock({ id: 'B1', content: 'Navigate me', parent_id: 'P1', todo_state: 'TODO' }),
    ])

    const user = userEvent.setup()
    render(<QueryResult expression={TABLE_EXPRESSION} onNavigate={onNavigate} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
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
  it('single property shorthand filter works (backward compat)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return {
          items: [
            makeBlock({ id: 'B1', content: 'TODO task', parent_id: 'P1', todo_state: 'TODO' }),
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText(/TODO task/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // Verify query_by_property was called with correct params
    expect(mockedInvoke).toHaveBeenCalledWith('query_by_property', {
      key: 'todo_state',
      valueText: 'TODO',
      valueDate: null,
      operator: 'eq',
      cursor: null,
      limit: 200,
    })
  })

  it('multiple property filters produce AND semantics', async () => {
    // Block B1 matches both filters, B2 matches only todo_state, B3 matches only priority
    const todoBlocks = [
      makeBlock({
        id: 'B1',
        content: 'High-pri TODO',
        parent_id: 'P1',
        todo_state: 'TODO',
        priority: '1',
      }),
      makeBlock({
        id: 'B2',
        content: 'Low-pri TODO',
        parent_id: 'P1',
        todo_state: 'TODO',
        priority: '3',
      }),
    ]
    const priorityBlocks = [
      makeBlock({
        id: 'B1',
        content: 'High-pri TODO',
        parent_id: 'P1',
        todo_state: 'TODO',
        priority: '1',
      }),
      makeBlock({
        id: 'B3',
        content: 'High-pri DONE',
        parent_id: 'P1',
        todo_state: 'DONE',
        priority: '1',
      }),
    ]

    mockedInvoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'query_by_property') {
        if ((args as { key: string }).key === 'todo_state') {
          return { items: todoBlocks, next_cursor: null, has_more: false }
        }
        if ((args as { key: string }).key === 'priority') {
          return { items: priorityBlocks, next_cursor: null, has_more: false }
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    }) as never)

    render(<QueryResult expression="property:todo_state=TODO property:priority=1" />)

    // Only B1 (intersection) should appear
    expect(await screen.findByText(/High-pri TODO/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // B2 and B3 should NOT appear
    expect(screen.queryByText(/Low-pri TODO/)).not.toBeInTheDocument()
    expect(screen.queryByText(/High-pri DONE/)).not.toBeInTheDocument()
  })

  it('tag + property combination works', async () => {
    const tagBlocks = [
      makeBlock({ id: 'B1', content: 'Tagged TODO', parent_id: 'P1', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'Tagged DONE', parent_id: 'P1', todo_state: 'DONE' }),
    ]
    const propertyBlocks = [
      makeBlock({ id: 'B1', content: 'Tagged TODO', parent_id: 'P1', todo_state: 'TODO' }),
      makeBlock({ id: 'B3', content: 'Untagged TODO', parent_id: 'P1', todo_state: 'TODO' }),
    ]

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return { items: tagBlocks, next_cursor: null, has_more: false }
      }
      if (cmd === 'query_by_property') {
        return { items: propertyBlocks, next_cursor: null, has_more: false }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="tag:project-x property:todo_state=TODO" />)

    // Only B1 (in both sets) should appear
    expect(await screen.findByText(/Tagged TODO/)).toBeInTheDocument()
    expect(screen.getByText('1 result')).toBeInTheDocument()

    // B2 (tag only) and B3 (property only) should NOT appear
    expect(screen.queryByText(/Tagged DONE/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Untagged TODO/)).not.toBeInTheDocument()
  })

  it('renders results from filtered query in table mode', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return {
          items: [
            makeBlock({
              id: 'B1',
              content: 'Filtered task',
              parent_id: 'P1',
              todo_state: 'TODO',
              priority: '1',
            }),
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'P1', title: 'Test Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO table:true" />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })

    const table = screen.getByRole('grid')
    expect(within(table).getByText(/Filtered task/)).toBeInTheDocument()
    expect(within(table).getByText('TODO')).toBeInTheDocument()
  })

  it('shows empty state when filtered results have no intersection', async () => {
    const set1 = [makeBlock({ id: 'B1', content: 'Only in set 1', parent_id: 'P1' })]
    const set2 = [makeBlock({ id: 'B2', content: 'Only in set 2', parent_id: 'P1' })]

    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        callCount++
        return {
          items: callCount === 1 ? set1 : set2,
          next_cursor: null,
          has_more: false,
        }
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
    mockedInvoke.mockRejectedValueOnce(new Error('Filter query broken'))

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText('Filter query broken')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows error when one sub-query in multi-filter rejects', async () => {
    // property filter succeeds, tag filter rejects — Promise.all propagates
    mockedInvoke
      .mockResolvedValueOnce({
        items: [
          {
            id: 'B1',
            block_type: 'content',
            content: 'Should not appear',
            parent_id: null,
            position: 1,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
            todo_state: 'TODO',
            priority: null,
            due_date: null,
            scheduled_date: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      })
      .mockRejectedValueOnce(new Error('Tag index corrupted'))

    render(<QueryResult expression="tag:project-x property:todo_state=TODO" />)

    expect(await screen.findByText('Tag index corrupted')).toBeInTheDocument()
    expect(screen.queryByText(/Should not appear/)).not.toBeInTheDocument()
  })

  it('shows error when batchResolve rejects after successful tag query', async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        items: [
          {
            id: 'B1',
            block_type: 'content',
            content: 'Result block',
            parent_id: 'P1',
            position: 1,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
            todo_state: null,
            priority: null,
            due_date: null,
            scheduled_date: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      })
      .mockRejectedValueOnce(new Error('Batch resolve failed'))

    render(<QueryResult expression="type:tag expr:project" />)

    expect(await screen.findByText('Batch resolve failed')).toBeInTheDocument()
  })

  it('shows error when batchResolve rejects after successful property query', async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        items: [
          {
            id: 'B1',
            block_type: 'content',
            content: 'Priority task',
            parent_id: 'P2',
            position: 1,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
            todo_state: 'TODO',
            priority: '1',
            due_date: null,
            scheduled_date: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      })
      .mockRejectedValueOnce(new Error('Resolution service down'))

    render(<QueryResult expression="type:property key:priority value:1" />)

    expect(await screen.findByText('Resolution service down')).toBeInTheDocument()
  })

  it('shows generic fallback for non-Error rejection', async () => {
    mockedInvoke.mockRejectedValueOnce('string error without Error wrapper')

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
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'First page item', parent_id: 'P1' })],
          next_cursor: 'cursor1',
          has_more: true,
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

  it('load more button is hidden when has_more is false', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Only page', parent_id: null })],
          next_cursor: null,
          has_more: false,
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
      if (cmd === 'query_by_tags') {
        callCount++
        if (callCount === 1) {
          return {
            items: [makeBlock({ id: 'B1', content: 'First page item', parent_id: null })],
            next_cursor: 'cursor1',
            has_more: true,
          }
        }
        return {
          items: [makeBlock({ id: 'B2', content: 'Second page item', parent_id: null })],
          next_cursor: null,
          has_more: false,
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
        return { items: [], next_cursor: null, has_more: false }
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
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
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
      if (cmd === 'query_by_tags') {
        return { items: [], next_cursor: null, has_more: false }
      }
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
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
        return { items: [], next_cursor: null, has_more: false }
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
/*  Operator syntax + relative date tests                             */
/* ------------------------------------------------------------------ */

describe('QueryResult – operator syntax', () => {
  it('passes operator "gt" to query_by_property for property:due_date>today', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
      }
      return null
    })

    render(<QueryResult expression="property:due_date>today" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'query_by_property',
        expect.objectContaining({
          key: 'due_date',
          operator: 'gt',
        }),
      )
    })

    // Verify "today" was resolved to an ISO date string
    const call = mockedInvoke.mock.calls.find((c) => c[0] === 'query_by_property')
    const args = call?.[1] as Record<string, unknown>
    expect(args.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(args.valueText).toBeNull()
  })

  it('passes operator "lte" to query_by_property for property:due_date<=2025-12-31', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
      }
      return null
    })

    render(<QueryResult expression="property:due_date<=2025-12-31" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'query_by_property',
        expect.objectContaining({
          key: 'due_date',
          operator: 'lte',
          valueDate: '2025-12-31',
        }),
      )
    })
  })

  it('backward compatible: property:key=value still works with operator "eq"', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return {
          items: [
            makeBlock({ id: 'B1', content: 'Eq result', parent_id: null, todo_state: 'TODO' }),
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') return []
      return null
    })

    render(<QueryResult expression="property:todo_state=TODO" />)

    expect(await screen.findByText(/Eq result/)).toBeInTheDocument()

    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_property',
      expect.objectContaining({
        key: 'todo_state',
        valueText: 'TODO',
        operator: 'eq',
      }),
    )
  })

  it('resolves relative date "today" to ISO date string', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
      }
      return null
    })

    render(<QueryResult expression="property:due_date>today" />)

    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find((c) => c[0] === 'query_by_property')
      expect(call).toBeDefined()
      const args = call?.[1] as Record<string, unknown>
      // "today" should be resolved to an ISO date (YYYY-MM-DD)
      expect(args.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(args.valueText).toBeNull()
    })
  })

  it('pills display operator symbol for gt', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
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
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
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
      if (cmd === 'query_by_property') {
        return { items: [], next_cursor: null, has_more: false }
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
        return { items: [], next_cursor: null, has_more: false }
      }
      return null
    })
  }

  function mockTagResultsWithBlock() {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [makeBlock({ id: 'B1', content: 'Result item', parent_id: 'P1' })],
          next_cursor: null,
          has_more: false,
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
        return { items: [], next_cursor: null, has_more: false }
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
})
