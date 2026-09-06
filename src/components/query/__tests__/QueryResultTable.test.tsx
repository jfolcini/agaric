import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'
import type { TableColumn } from '@/components/query/QueryResultTable'
import { QueryResultTable } from '@/components/query/QueryResultTable'
import { unresolvedBlockLabel } from '@/lib/block-title'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

/** Target of the `[[…]]` link in the #4719 rows below. */
const LINKED_PAGE_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'

// The content cell renders through the resolve store; stub the hook so the
// chip has a title to show without standing a store up. (`AlertSection.test.tsx`
// does the same for the agenda rows fixed by #4705.)
vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) =>
      id === LINKED_PAGE_ID ? 'Quarterly Plan' : undefined,
    ),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

/** The `resolveBlockTitle` PROP: same cache, so it agrees with the chips. */
const resolveTitleProp = (id: string): string =>
  id === LINKED_PAGE_ID ? 'Quarterly Plan' : unresolvedBlockLabel(id)

const defaultColumns: TableColumn[] = [
  { key: 'content', label: 'Content' },
  { key: 'todo_state', label: 'Status' },
]

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

    const table = screen.getByRole('table')
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

    const table = screen.getByRole('table')
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

    const table = screen.getByRole('table')
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

    await user.click(screen.getByRole('button', { name: 'Sort by Content' }))
    expect(onColumnSort).toHaveBeenCalledWith('content')

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }))
    expect(onColumnSort).toHaveBeenCalledWith('todo_state')
  })

  it('triggers sort on Enter / Space when column header has keyboard focus', async () => {
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

    const contentSortBtn = screen.getByRole('button', { name: 'Sort by Content' })
    contentSortBtn.focus()
    expect(contentSortBtn).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onColumnSort).toHaveBeenCalledWith('content')

    onColumnSort.mockClear()
    const statusSortBtn = screen.getByRole('button', { name: 'Sort by Status' })
    statusSortBtn.focus()
    await user.keyboard(' ')
    expect(onColumnSort).toHaveBeenCalledWith('todo_state')
  })

  it('does not have role="grid" on the table', () => {
    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO' })]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
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
        results={[makeBlock({ id: 'B1', content: 'Navigate me', parent_id: 'P1', page_id: 'P1' })]}
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
        results={[makeBlock({ id: 'B1', content: 'No parent', parent_id: null, page_id: null })]}
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
        results={[makeBlock({ id: 'B1', content: 'Task', parent_id: 'P1', page_id: 'P1' })]}
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
        results={[makeBlock({ id: 'B1', content: 'Task', parent_id: 'P1', page_id: 'P1' })]}
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

  // Missing values must render as an em-dash placeholder, not blank.
  it('renders em-dash placeholder for null property values', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'priority', label: 'Priority' },
      { key: 'due_date', label: 'Due Date' },
    ]

    render(
      <QueryResultTable
        results={[
          makeBlock({
            id: 'B1',
            content: 'Sparse task',
            priority: null,
            due_date: null,
          }),
        ]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    // Two missing cells (priority + due_date) should render the em-dash.
    const placeholders = screen.getAllByText('\u2014')
    expect(placeholders).toHaveLength(2)
  })

  it('renders custom-property column values from the customProps map', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'prop:area', label: 'area', propKey: 'area' },
    ]
    const customProps = new Map([['B1', new Map([['area', 'frontend']])]])

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Task' })]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        customProps={customProps}
      />,
    )

    const table = screen.getByRole('table')
    expect(within(table).getByText('area')).toBeInTheDocument()
    expect(within(table).getByText('frontend')).toBeInTheDocument()
  })

  it('renders em-dash for a custom-property column with no value on the block', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'prop:area', label: 'area', propKey: 'area' },
    ]

    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Task' })]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        customProps={new Map()}
      />,
    )

    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders em-dash placeholder for empty-string property values', () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'priority', label: 'Priority' },
    ]

    render(
      <QueryResultTable
        results={[
          makeBlock({
            id: 'B1',
            content: 'Empty-string task',
            priority: '',
          }),
        ]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    expect(screen.getByText('\u2014')).toBeInTheDocument()
  })

  // The content cell must carry the same coarse-pointer padding as
  // the adjacent page cell so the row is consistently 44 px tall on touch.
  it('content cell has [@media(pointer:coarse)]:py-3 to match the page cell', () => {
    const columns: TableColumn[] = [{ key: 'content', label: 'Content' }]
    const { container } = render(
      <QueryResultTable
        results={[
          makeBlock({
            id: 'B1',
            content: 'Task',
            todo_state: 'TODO',
            parent_id: 'P1',
            page_id: 'P1',
          }),
        ]}
        columns={columns}
        pageTitles={new Map([['P1', 'Page']])}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const cells = container.querySelectorAll('tbody td')
    expect(cells.length).toBeGreaterThanOrEqual(2)
    // Every <td> in the body should have the coarse-pointer padding so the
    // Row sizing is consistent (visual mismatch fix).
    for (const cell of cells) {
      expect((cell as HTMLElement).className).toContain('[@media(pointer:coarse)]:py-3')
    }
  })

  // Header sort buttons must hit the 44 px touch-target floor
  // on coarse-pointer devices.
  it('header sort buttons carry the touch-target utility', () => {
    render(
      <QueryResultTable
        results={[makeBlock({ todo_state: 'TODO' })]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const sortButtons = [
      screen.getByRole('button', { name: 'Sort by Content' }),
      screen.getByRole('button', { name: 'Sort by Status' }),
    ]
    for (const btn of sortButtons) {
      const cls = btn.className
      expect(cls.includes('touch-target') || cls.includes('[@media(pointer:coarse)]:h-11')).toBe(
        true,
      )
    }
  })

  it('has no a11y violations', async () => {
    const columns: TableColumn[] = [
      { key: 'content', label: 'Content' },
      { key: 'todo_state', label: 'Status' },
    ]

    const { container } = render(
      <QueryResultTable
        results={[
          makeBlock({
            id: 'B1',
            content: 'Accessible task',
            todo_state: 'TODO',
            parent_id: 'P1',
            page_id: 'P1',
          }),
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

/**
 * #4719 — the content cell used to render `resolveBlockDisplay`'s plain
 * `title`, and that string comes from `truncateContent`, which strips a
 * `[[ULID]]`'s brackets and leaves the ULID. The fallback is the NORMAL path
 * for a cross-page query row, so a cell whose block reads
 * `follow up on [[01KP36…]]` showed the raw id. The cell renders rich content
 * now, matching `QueryResultList` — the two share `QueryResultRowContent`.
 */
describe('QueryResultTable — rich content cell (#4719)', () => {
  const linkedRow = () =>
    makeBlock({
      id: 'B1',
      parent_id: 'P1',
      page_id: 'P1',
      todo_state: 'TODO',
      content: `follow up on [[${LINKED_PAGE_ID}]]`,
    })

  // No `pageTitles` entry, so no `PageLink` in the row — the file's other axe
  // test omits it too, and it is beside the point here.
  const renderLinkedRow = () =>
    render(
      <QueryResultTable
        results={[linkedRow()]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        resolveBlockTitle={resolveTitleProp}
      />,
    )

  it('renders the link target as a titled chip, never as a bare ULID', () => {
    const { container } = renderLinkedRow()

    expect(screen.getByTestId('block-link-chip')).toHaveTextContent('Quarterly Plan')
    expect(container.textContent).not.toContain(LINKED_PAGE_ID)
  })

  it('keeps a correct accessible name on the cell button', () => {
    // The button's label is an element tree now, so the name comes from
    // `aria-label` — which resolves the same reference the chip does, so it
    // still CONTAINS the visible text (WCAG 2.5.3).
    //
    // Asserted on the ATTRIBUTE: the chip resolves to the same string, so the
    // computed name matches from the button's text content alone and a
    // role-name query would stay green with the `aria-label` deleted.
    renderLinkedRow()

    const cellButton = screen.getByTestId('block-link-chip').closest('button')
    expect(cellButton).toHaveAttribute('aria-label', 'follow up on Quarterly Plan')
  })

  it('resolves the name with no resolveBlockTitle prop — the AdvancedQuery path', () => {
    // The prop is optional and two callers of the sibling list omit it while
    // their rows still resolve chips; substituting the name through the prop
    // alone left such a cell named after the raw ULID beside a chip reading
    // "Quarterly Plan". See the `QueryResultList` twin.
    render(
      <QueryResultTable
        results={[linkedRow()]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
      />,
    )

    const cellButton = screen.getByTestId('block-link-chip').closest('button')
    expect(cellButton).toHaveAttribute('aria-label', 'follow up on Quarterly Plan')
    expect(cellButton?.getAttribute('aria-label')).not.toContain(LINKED_PAGE_ID)
  })

  it('the cell button still navigates', async () => {
    // The rich body must not swallow the click: the chips are inert
    // (`interactive: false`), so the click reaches the button.
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      <QueryResultTable
        results={[linkedRow()]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        resolveBlockTitle={resolveTitleProp}
        onNavigate={onNavigate}
      />,
    )

    await user.click(screen.getByTestId('block-link-chip'))

    expect(onNavigate).toHaveBeenCalledWith('P1')
  })

  it('has no a11y violations with a rich content cell', async () => {
    // Guards the NEW markup (a rich body nested inside the cell's <button>),
    // so it is green on the pre-fix code by construction. Falsifiable against
    // the plausible WRONG fix, exactly as its `QueryResultList` twin: the
    // markdown link renders `role="link"` unconditionally and picks up
    // `tabIndex={0}` when the surface is interactive, so dropping
    // `interactive: false` nests a focusable link inside the <button> and axe
    // reports `nested-interactive`.
    const { container } = render(
      <QueryResultTable
        results={[
          makeBlock({
            id: 'B1',
            parent_id: 'P1',
            page_id: 'P1',
            todo_state: 'TODO',
            content: `follow up on [[${LINKED_PAGE_ID}]] see [docs](https://example.com)`,
          }),
        ]}
        columns={defaultColumns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        resolveBlockTitle={resolveTitleProp}
      />,
    )

    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()
  })
})
