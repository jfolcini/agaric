import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'
import { useNavigationStore } from '../../stores/navigation'
import type { TableColumn } from '../QueryResultTable'
import { QueryResultTable } from '../QueryResultTable'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const defaultColumns: TableColumn[] = [
  { key: 'content', label: 'Content' },
  { key: 'todo_state', label: 'Status' },
]

beforeEach(() => {
  vi.clearAllMocks()
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

describe('QueryResultTable', () => {
  it('renders a table with correct column headers', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'todo_state', label: 'Status' },
      { key: 'priority', label: 'Priority' },
    ]

    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO', priority: '1' })]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const table = screen.getByRole('grid')
    expect(within(table).getByText('Content')).toBeInTheDocument()
    expect(within(table).getByText('Status')).toBeInTheDocument()
    expect(within(table).getByText('Priority')).toBeInTheDocument()
    expect(within(table).getByText('Page')).toBeInTheDocument()
  })

  it('renders data rows with correct cell values', () => {
    const results = [
      makeBlock({ id: 'B1', content: 'Task Alpha', todo_state: 'TODO' }),
      makeBlock({ id: 'B2', content: 'Task Beta', todo_state: 'DONE' }),
    ]

    render(
      <QueryResultTable
        results={results}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const table = screen.getByRole('grid')
    expect(within(table).getByText('Task Alpha')).toBeInTheDocument()
    expect(within(table).getByText('Task Beta')).toBeInTheDocument()
    expect(within(table).getByText('TODO')).toBeInTheDocument()
    expect(within(table).getByText('DONE')).toBeInTheDocument()
  })

  it('renders empty table body when no results', () => {
    render(
      <QueryResultTable
        results={[]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const table = screen.getByRole('grid')
    // Header row exists, but no data rows
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(1) // only header row
  })

  it('calls onColumnSort when clicking a column header', async () => {
    const onColumnSort = vi.fn()
    const user = userEvent.setup()

    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO' })]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={onColumnSort}
      />,
    )

    await user.click(screen.getByText('Content'))
    expect(onColumnSort).toHaveBeenCalledWith('content')

    await user.click(screen.getByText('Status'))
    expect(onColumnSort).toHaveBeenCalledWith('todo_state')
  })

  it('shows ascending aria-sort on active sort column', () => {
    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO' })]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey="content"
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const contentHeader = screen.getByText('Content').closest('th')
    expect(contentHeader).toHaveAttribute('aria-sort', 'ascending')

    const statusHeader = screen.getByText('Status').closest('th')
    expect(statusHeader).toHaveAttribute('aria-sort', 'none')
  })

  it('shows descending aria-sort on active sort column', () => {
    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO' })]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey="content"
        sortDir="desc"
        onColumnSort={vi.fn()}
      />,
    )

    const contentHeader = screen.getByText('Content').closest('th')
    expect(contentHeader).toHaveAttribute('aria-sort', 'descending')
  })

  it('calls onNavigate when clicking a content cell', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Navigate me', parent_id: 'P1' })]}
        columns={[{ key: 'content', label: 'Content' }]}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        onNavigate={onNavigate}
      />,
    )

    const link = screen.getByText('Navigate me')
    await user.click(link.closest('button') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('does not call onNavigate when parent_id is null', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'No parent', parent_id: null })]}
        columns={[{ key: 'content', label: 'Content' }]}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        onNavigate={onNavigate}
      />,
    )

    const link = screen.getByText('No parent')
    await user.click(link.closest('button') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('renders page title link in Page column when available', () => {
    const pageTitles = new Map([['P1', 'Project Page']])

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Task', parent_id: 'P1' })]}
        columns={[{ key: 'content', label: 'Content' }]}
        pageTitles={pageTitles}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    expect(screen.getByRole('link', { name: 'Project Page' })).toBeInTheDocument()
  })

  it('renders empty Page cell when no page title available', () => {
    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Task', parent_id: 'P1' })]}
        columns={[{ key: 'content', label: 'Content' }]}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('uses resolveBlockTitle when provided', () => {
    const resolveBlockTitle = vi.fn().mockReturnValue('Resolved Title')

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Raw content' })]}
        columns={[{ key: 'content', label: 'Content' }]}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        resolveBlockTitle={resolveBlockTitle}
      />,
    )

    expect(resolveBlockTitle).toHaveBeenCalledWith('B1')
    expect(screen.getByText('Resolved Title')).toBeInTheDocument()
    expect(screen.queryByText('Raw content')).not.toBeInTheDocument()
  })

  it('renders non-content columns as plain spans', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'due_date', label: 'Due Date' },
    ]

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Task', due_date: '2025-06-01' })]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    expect(screen.getByText('2025-06-01')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'todo_state', label: 'Status' },
    ]

    const { container } = render(
      <QueryResultTable
        results={[
          makeBlock({ id: 'B1', content: 'Accessible task', todo_state: 'TODO', parent_id: 'P1' }),
        ]}
        columns={columns}
        pageTitles={new Map([['P1', 'Page']])}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()
  })
})
