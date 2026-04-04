import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { buildFilters, detectColumns, parseQueryExpression, QueryResult } from '../QueryResult'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
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
      propertyFilters: [{ key: 'todo_state', value: 'TODO' }],
      tagFilters: [],
    })
  })

  it('parses multiple property shorthands (AND)', () => {
    const result = parseQueryExpression('property:todo_state=TODO property:priority=1')
    expect(result).toEqual({
      type: 'filtered',
      params: {},
      propertyFilters: [
        { key: 'todo_state', value: 'TODO' },
        { key: 'priority', value: '1' },
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
      propertyFilters: [{ key: 'todo_state', value: 'TODO' }],
      tagFilters: ['project-x'],
    })
  })

  it('preserves extra params alongside shorthand filters', () => {
    const result = parseQueryExpression('property:todo_state=TODO table:true')
    expect(result).toEqual({
      type: 'filtered',
      params: { table: 'true' },
      propertyFilters: [{ key: 'todo_state', value: 'TODO' }],
      tagFilters: [],
    })
  })
})

describe('QueryResult', () => {
  it('renders loading state', () => {
    mockedInvoke.mockReturnValue(new Promise(() => {})) // never resolves
    render(<QueryResult expression="type:tag expr:project" />)
    expect(screen.getByText('...')).toBeInTheDocument()
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
              archived_at: null,
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

    expect(await screen.findByText('No results')).toBeInTheDocument()
    expect(screen.getByText('0 results')).toBeInTheDocument()
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
              archived_at: null,
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
    const header = screen.getByText('type:tag expr:test').closest('button')!
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
              archived_at: null,
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
    await user.click(item.closest('button')!)

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
              archived_at: null,
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
              archived_at: null,
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
              archived_at: null,
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
        archived_at: null,
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
        archived_at: null,
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

  const makeBlock = (overrides: Partial<{
    id: string
    content: string
    parent_id: string | null
    todo_state: string | null
    priority: string | null
    due_date: string | null
    scheduled_date: string | null
  }> = {}) => ({
    id: overrides.id ?? 'B1',
    block_type: 'content',
    content: overrides.content ?? 'Task A',
    parent_id: overrides.parent_id ?? 'P1',
    position: 1,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: overrides.todo_state ?? 'TODO',
    priority: overrides.priority ?? null,
    due_date: overrides.due_date ?? null,
    scheduled_date: overrides.scheduled_date ?? null,
  })

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
          items: [makeBlock()],
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
      expect(screen.getByRole('list')).toBeInTheDocument()
    })
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('renders as table when table:true in query params', async () => {
    mockTagResults([makeBlock()])

    render(<QueryResult expression={TABLE_EXPRESSION} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })
    // Should NOT have a list
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('table has correct columns from block properties', async () => {
    mockTagResults([
      makeBlock({ id: 'B1', content: 'Task A', todo_state: 'TODO', priority: '1', due_date: '2025-06-01' }),
      makeBlock({ id: 'B2', content: 'Task B', todo_state: 'DONE', priority: '2', due_date: null }),
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
      makeBlock({ id: 'B1', content: 'Beta task', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'Alpha task', todo_state: 'DONE' }),
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

    expect(within(firstDataRow).getByText(/Alpha task/)).toBeInTheDocument()
    expect(within(secondDataRow).getByText(/Beta task/)).toBeInTheDocument()

    // Verify aria-sort is set
    expect(contentHeader.closest('th')).toHaveAttribute('aria-sort', 'ascending')

    // Click again to sort descending
    await user.click(contentHeader)

    expect(contentHeader.closest('th')).toHaveAttribute('aria-sort', 'descending')

    const rowsAfter = within(table).getAllByRole('row')
    expect(within(rowsAfter[1]).getByText(/Beta task/)).toBeInTheDocument()
    expect(within(rowsAfter[2]).getByText(/Alpha task/)).toBeInTheDocument()
  })

  it('table content cells are clickable and navigate', async () => {
    const onNavigate = vi.fn()
    mockTagResults([makeBlock({ id: 'B1', content: 'Navigate me', parent_id: 'P1', todo_state: 'TODO' })])

    const user = userEvent.setup()
    render(<QueryResult expression={TABLE_EXPRESSION} onNavigate={onNavigate} />)

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument()
    })

    const link = screen.getByText(/Navigate me/)
    await user.click(link.closest('button')!)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('axe a11y for table mode', async () => {
    mockTagResults([
      makeBlock({ id: 'B1', content: 'Accessible task', todo_state: 'TODO', priority: '1' }),
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
    expect(filters).toEqual([
      { type: 'PropertyText', key: 'status', op: 'Eq', value: 'active' },
    ])
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
  const makeBlock = (overrides: Partial<{
    id: string
    content: string
    parent_id: string | null
    todo_state: string | null
    priority: string | null
    due_date: string | null
    scheduled_date: string | null
  }> = {}) => ({
    id: overrides.id ?? 'B1',
    block_type: 'content',
    content: overrides.content ?? 'Task A',
    parent_id: overrides.parent_id ?? 'P1',
    position: 1,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: overrides.todo_state ?? null,
    priority: overrides.priority ?? null,
    due_date: overrides.due_date ?? null,
    scheduled_date: overrides.scheduled_date ?? null,
  })

  it('single property shorthand filter works (backward compat)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_property') {
        return {
          items: [
            makeBlock({ id: 'B1', content: 'TODO task', todo_state: 'TODO' }),
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
      cursor: null,
      limit: 200,
    })
  })

  it('multiple property filters produce AND semantics', async () => {
    // Block B1 matches both filters, B2 matches only todo_state, B3 matches only priority
    const todoBlocks = [
      makeBlock({ id: 'B1', content: 'High-pri TODO', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'B2', content: 'Low-pri TODO', todo_state: 'TODO', priority: '3' }),
    ]
    const priorityBlocks = [
      makeBlock({ id: 'B1', content: 'High-pri TODO', todo_state: 'TODO', priority: '1' }),
      makeBlock({ id: 'B3', content: 'High-pri DONE', todo_state: 'DONE', priority: '1' }),
    ]

    mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
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
    })

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
      makeBlock({ id: 'B1', content: 'Tagged TODO', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'Tagged DONE', todo_state: 'DONE' }),
    ]
    const propertyBlocks = [
      makeBlock({ id: 'B1', content: 'Tagged TODO', todo_state: 'TODO' }),
      makeBlock({ id: 'B3', content: 'Untagged TODO', todo_state: 'TODO' }),
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
            makeBlock({ id: 'B1', content: 'Filtered task', todo_state: 'TODO', priority: '1' }),
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
    const set1 = [makeBlock({ id: 'B1', content: 'Only in set 1' })]
    const set2 = [makeBlock({ id: 'B2', content: 'Only in set 2' })]

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
