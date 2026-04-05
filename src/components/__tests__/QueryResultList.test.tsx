import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BlockRow } from '../../lib/tauri'
import { useNavigationStore } from '../../stores/navigation'
import { QueryResultList } from '../QueryResultList'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

function makeBlock(
  overrides: Partial<{
    id: string
    content: string
    parent_id: string | null
    todo_state: string | null
    priority: string | null
    due_date: string | null
    scheduled_date: string | null
  }> = {},
): BlockRow {
  return {
    id: overrides.id ?? 'B1',
    block_type: 'content',
    content: overrides.content ?? 'Test block',
    parent_id: overrides.parent_id ?? null,
    position: 1,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: overrides.todo_state ?? null,
    priority: overrides.priority ?? null,
    due_date: overrides.due_date ?? null,
    scheduled_date: overrides.scheduled_date ?? null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    pageStack: [],
    selectedBlockId: null,
  })
})

describe('QueryResultList', () => {
  it('renders a list of results', () => {
    const results = [
      makeBlock({ id: 'B1', content: 'First task' }),
      makeBlock({ id: 'B2', content: 'Second task' }),
    ]

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
  })

  it('renders empty list when no results', () => {
    const { container } = render(<QueryResultList results={[]} pageTitles={new Map()} />)

    const list = container.querySelector('ul')
    expect(list).toBeInTheDocument()
    expect(list?.children).toHaveLength(0)
  })

  it('displays todo_state badge when present', () => {
    const results = [
      makeBlock({ id: 'B1', content: 'TODO task', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'DONE task', todo_state: 'DONE' }),
      makeBlock({ id: 'B3', content: 'DOING task', todo_state: 'DOING' }),
    ]

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('DONE')).toBeInTheDocument()
    expect(screen.getByText('DOING')).toBeInTheDocument()
  })

  it('does not render badge when todo_state is null', () => {
    const results = [makeBlock({ id: 'B1', content: 'No state' })]

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    expect(screen.getByText('No state')).toBeInTheDocument()
    expect(screen.queryByText('TODO')).not.toBeInTheDocument()
    expect(screen.queryByText('DONE')).not.toBeInTheDocument()
  })

  it('calls onNavigate when clicking a result with parent_id', async () => {
    const onNavigate = vi.fn()
    const results = [makeBlock({ id: 'B1', content: 'Click me', parent_id: 'P1' })]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} onNavigate={onNavigate} />)

    const item = screen.getByText('Click me')
    await user.click(item.closest('button') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('does not call onNavigate when parent_id is null', async () => {
    const onNavigate = vi.fn()
    const results = [makeBlock({ id: 'B1', content: 'No parent', parent_id: null })]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} onNavigate={onNavigate} />)

    const item = screen.getByText('No parent')
    await user.click(item.closest('button') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('renders page title link when pageTitles map has the parent_id', () => {
    const results = [makeBlock({ id: 'B1', content: 'With page', parent_id: 'P1' })]
    const pageTitles = new Map([['P1', 'My Page']])

    render(<QueryResultList results={results} pageTitles={pageTitles} />)

    expect(screen.getByRole('link', { name: 'My Page' })).toBeInTheDocument()
  })

  it('does not render page link when pageTitles map lacks parent_id', () => {
    const results = [makeBlock({ id: 'B1', content: 'No page link', parent_id: 'P1' })]

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('uses resolveBlockTitle when provided', () => {
    const results = [makeBlock({ id: 'B1', content: 'Raw content' })]
    const resolveBlockTitle = vi.fn().mockReturnValue('Resolved Title')

    render(
      <QueryResultList
        results={results}
        pageTitles={new Map()}
        resolveBlockTitle={resolveBlockTitle}
      />,
    )

    expect(resolveBlockTitle).toHaveBeenCalledWith('B1')
    expect(screen.getByText('Resolved Title')).toBeInTheDocument()
    expect(screen.queryByText('Raw content')).not.toBeInTheDocument()
  })

  it('falls back to truncated content when resolveBlockTitle returns empty', () => {
    const results = [makeBlock({ id: 'B1', content: 'Fallback content' })]
    const resolveBlockTitle = vi.fn().mockReturnValue('')

    render(
      <QueryResultList
        results={results}
        pageTitles={new Map()}
        resolveBlockTitle={resolveBlockTitle}
      />,
    )

    expect(screen.getByText('Fallback content')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const results = [
      makeBlock({ id: 'B1', content: 'Accessible item', todo_state: 'TODO', parent_id: null }),
    ]

    const { container } = render(<QueryResultList results={results} pageTitles={new Map()} />)

    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()
  })
})
