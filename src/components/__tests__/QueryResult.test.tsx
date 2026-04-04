import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { parseQueryExpression, QueryResult } from '../QueryResult'

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
    })
  })

  it('parses property query', () => {
    expect(parseQueryExpression('type:property key:priority value:1')).toEqual({
      type: 'property',
      params: { type: 'property', key: 'priority', value: '1' },
    })
  })

  it('returns unknown for missing type', () => {
    expect(parseQueryExpression('foo:bar')).toEqual({
      type: 'unknown',
      params: { foo: 'bar' },
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
