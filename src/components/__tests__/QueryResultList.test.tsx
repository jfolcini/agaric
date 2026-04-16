import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'
import { useNavigationStore } from '../../stores/navigation'
import { QueryResultList } from '../QueryResultList'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
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

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
  })

  it('renders empty list when no results', () => {
    render(<QueryResultList results={[]} pageTitles={new Map()} />)

    const list = screen.getByRole('listbox')
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

  it('calls onNavigate when clicking a result with page_id', async () => {
    const onNavigate = vi.fn()
    const results = [makeBlock({ id: 'B1', content: 'Click me', parent_id: 'P1', page_id: 'P1' })]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} onNavigate={onNavigate} />)

    const item = screen.getByText('Click me')
    await user.click(item.closest('[role="option"]') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('does not call onNavigate when page_id is null', async () => {
    const onNavigate = vi.fn()
    const results = [makeBlock({ id: 'B1', content: 'No parent', parent_id: null, page_id: null })]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} onNavigate={onNavigate} />)

    const item = screen.getByText('No parent')
    await user.click(item.closest('[role="option"]') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('renders page title link when pageTitles map has the page_id', () => {
    const results = [makeBlock({ id: 'B1', content: 'With page', parent_id: 'P1', page_id: 'P1' })]
    const pageTitles = new Map([['P1', 'My Page']])

    render(<QueryResultList results={results} pageTitles={pageTitles} />)

    expect(screen.getByRole('link', { name: 'My Page' })).toBeInTheDocument()
  })

  it('does not render page link when pageTitles map lacks page_id', () => {
    const results = [
      makeBlock({ id: 'B1', content: 'No page link', parent_id: 'P1', page_id: 'P1' }),
    ]

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
      makeBlock({
        id: 'B1',
        content: 'Accessible item',
        todo_state: 'TODO',
        parent_id: null,
        page_id: null,
      }),
    ]

    const { container } = render(<QueryResultList results={results} pageTitles={new Map()} />)

    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()
  })

  it('supports arrow-key navigation', async () => {
    const results = [
      makeBlock({ id: 'B1', content: 'First' }),
      makeBlock({ id: 'B2', content: 'Second' }),
      makeBlock({ id: 'B3', content: 'Third' }),
    ]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    const listbox = screen.getByRole('listbox')
    await user.click(listbox)

    // Initially first item is focused
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')

    // ArrowDown moves to second item
    await user.keyboard('{ArrowDown}')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    // ArrowDown again moves to third item
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')

    // ArrowUp moves back to second item
    await user.keyboard('{ArrowUp}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('navigates on Enter key', async () => {
    const onNavigate = vi.fn()
    const results = [
      makeBlock({ id: 'B1', content: 'First', parent_id: 'P1', page_id: 'P1' }),
      makeBlock({ id: 'B2', content: 'Second', parent_id: 'P2', page_id: 'P2' }),
    ]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} onNavigate={onNavigate} />)

    const listbox = screen.getByRole('listbox')
    await user.click(listbox)

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('P2')
  })

  it('wraps around on arrow keys', async () => {
    const results = [
      makeBlock({ id: 'B1', content: 'First' }),
      makeBlock({ id: 'B2', content: 'Second' }),
      makeBlock({ id: 'B3', content: 'Third' }),
    ]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    const listbox = screen.getByRole('listbox')
    await user.click(listbox)

    const options = screen.getAllByRole('option')

    // ArrowDown past last item wraps to first
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // ArrowUp from first item wraps to last
    await user.keyboard('{ArrowUp}')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
  })

  // =========================================================================
  // Home/End and PageUp/PageDown keyboard navigation (UX-138)
  // =========================================================================

  it('Home key moves focus to first result, End to last', async () => {
    const results = [
      makeBlock({ id: 'B1', content: 'First' }),
      makeBlock({ id: 'B2', content: 'Second' }),
      makeBlock({ id: 'B3', content: 'Third' }),
    ]
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    const listbox = screen.getByRole('listbox')
    await user.click(listbox)

    const options = screen.getAllByRole('option')

    // Move to second item
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    // End key should jump to last item
    await user.keyboard('{End}')
    expect(options[2]).toHaveAttribute('aria-selected', 'true')

    // Home key should jump to first item
    await user.keyboard('{Home}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('PageDown/PageUp navigate through results', async () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeBlock({ id: `B${i}`, content: `Item ${i}` }),
    )
    const user = userEvent.setup()

    render(<QueryResultList results={results} pageTitles={new Map()} />)

    const listbox = screen.getByRole('listbox')
    await user.click(listbox)

    const options = screen.getAllByRole('option')

    // PageDown should jump forward by 10
    await user.keyboard('{PageDown}')
    expect(options[10]).toHaveAttribute('aria-selected', 'true')

    // PageUp should jump back by 10
    await user.keyboard('{PageUp}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })
})
