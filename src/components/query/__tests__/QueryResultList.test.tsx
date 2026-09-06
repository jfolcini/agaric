import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '@/__tests__/fixtures'
import { QueryResultList } from '@/components/query/QueryResultList'
import { unresolvedBlockLabel } from '@/lib/block-title'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

/** Target of the `[[…]]` link in the #4719 rows below. */
const LINKED_PAGE_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'
/** A link target whose page is NAMESPACED: the chip shows the leaf only. */
const NAMESPACED_PAGE_ID = '01KP36KDG2NAMESPACEDPAGE01'

// The row body renders through the resolve store; stub the hook so the chip
// has a title to show without standing a store up. (`AlertSection.test.tsx`
// does the same for the agenda rows fixed by #4705.)
vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn((id: string) =>
      id === LINKED_PAGE_ID
        ? 'Quarterly Plan'
        : id === NAMESPACED_PAGE_ID
          ? 'Work/Quarterly Plan'
          : undefined,
    ),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

/** The `resolveBlockTitle` PROP: same cache, so it agrees with the chips. */
const resolveTitleProp = (id: string): string =>
  id === LINKED_PAGE_ID
    ? 'Quarterly Plan'
    : id === NAMESPACED_PAGE_ID
      ? 'Work/Quarterly Plan'
      : unresolvedBlockLabel(id)

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

  it('renders page title as plain text when pageTitles map has the page_id', () => {
    const results = [makeBlock({ id: 'B1', content: 'With page', parent_id: 'P1', page_id: 'P1' })]
    const pageTitles = new Map([['P1', 'My Page']])

    render(<QueryResultList results={results} pageTitles={pageTitles} />)

    // #4737 — plain text, not a nested `role="link"`: see QueryResultList.tsx.
    expect(screen.getByText('My Page')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('does not render page title when pageTitles map lacks page_id', () => {
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
    // #4737 — `parent_id`/`page_id` set and a matching `pageTitles` entry, so
    // the row renders its page-title span. The old fixture set both to
    // `null`, which suppressed that span and hid the `nested-interactive`
    // violation `PageLink`'s `role="link"` produced inside `role="option"`.
    const results = [
      makeBlock({
        id: 'B1',
        content: 'Accessible item',
        todo_state: 'TODO',
        parent_id: 'P1',
        page_id: 'P1',
      }),
    ]

    const { container } = render(
      <QueryResultList results={results} pageTitles={new Map([['P1', 'My Page']])} />,
    )

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
  // Home/End and PageUp/PageDown keyboard navigation
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

  it('listbox aria-label resolves via t()', () => {
    const results = [makeBlock({ id: 'B1', content: 'i18n test' })]
    render(<QueryResultList results={results} pageTitles={new Map()} />)
    const listbox = screen.getByRole('listbox', { name: t('query.resultsListLabel') })
    expect(listbox).toBeInTheDocument()
  })
})

/**
 * #4719 — the row used to render `resolveBlockDisplay`'s plain `title`, and
 * that string comes from `truncateContent`, which strips a `[[ULID]]`'s
 * brackets and leaves the ULID. The fallback is the NORMAL path for a
 * cross-page query row, so `follow up on [[01KP36…]]` read as
 * `follow up on 01KP36KDG2ABCDEFGHJKMNPQRS` with no way to tell what it
 * pointed at. The row renders rich content now, as every other surface does.
 */
describe('QueryResultList — rich row content (#4719)', () => {
  const linkedRow = () =>
    makeBlock({
      id: 'B1',
      parent_id: 'P1',
      page_id: 'P1',
      content: `follow up on [[${LINKED_PAGE_ID}]]`,
    })

  // No `pageTitles` entry, so no page-title span in the row: these fixtures
  // are about the rich-content chip (#4719), and the page-title span is
  // covered separately (#4737).
  const renderLinkedRow = () =>
    render(
      <QueryResultList
        results={[linkedRow()]}
        pageTitles={new Map()}
        resolveBlockTitle={resolveTitleProp}
      />,
    )

  it('renders the link target as a titled chip, never as a bare ULID', () => {
    const { container } = renderLinkedRow()

    expect(screen.getByTestId('block-link-chip')).toHaveTextContent('Quarterly Plan')
    // Not merely "the chip is right": the id must be gone from the row
    // ENTIRELY, which is the symptom the issue reports.
    expect(container.textContent).not.toContain(LINKED_PAGE_ID)
  })

  it('keeps a correct accessible name on the role="option" row', () => {
    // The visible text is now an element tree, so the name comes from
    // `aria-label`. It resolves the same reference the chip does, so it still
    // CONTAINS the visible text (WCAG 2.5.3) instead of naming the row after
    // the raw id the chip no longer shows.
    //
    // Asserted on the ATTRIBUTE, not via `getByRole({ name })`: with the chip
    // resolving to the same string, the computed name matches from the row's
    // text content alone, so a role-name query passes with no `aria-label` at
    // all and would not see it deleted.
    renderLinkedRow()

    const option = screen.getByTestId('query-result-item')
    expect(option).toHaveAttribute('aria-label', 'follow up on Quarterly Plan')
  })

  it('names the row from aria-label, not from the chip text it abbreviates', () => {
    // The case where the two genuinely differ, so the ROLE-NAME query below
    // can only be satisfied by `aria-label`: a namespaced target renders the
    // chip as its LEAF (`getPageDisplayName(…, 'leaf')`) while the name keeps
    // the full path — a superset, which still satisfies 2.5.3.
    render(
      <QueryResultList
        results={[
          makeBlock({
            id: 'B1',
            parent_id: 'P1',
            page_id: 'P1',
            content: `follow up on [[${NAMESPACED_PAGE_ID}]]`,
          }),
        ]}
        pageTitles={new Map()}
        resolveBlockTitle={resolveTitleProp}
      />,
    )

    expect(screen.getByTestId('block-link-chip')).toHaveTextContent('Quarterly Plan')
    expect(screen.getByTestId('block-link-chip')).not.toHaveTextContent('Work/')
    expect(
      screen.getByRole('option', { name: 'follow up on Work/Quarterly Plan' }),
    ).toBeInTheDocument()
  })

  it('names the row with the badge and page it also shows, not the body alone', () => {
    // An `aria-label` REPLACES the contents as the accessible name, and the
    // `role="option"` contains three visible things. Before the label existed
    // the computed name was "TODO call the plumber My Page"; naming the row
    // after the body alone drops the state and the page from what a screen
    // reader announces.
    render(
      <QueryResultList
        results={[
          makeBlock({
            id: 'B1',
            parent_id: 'P1',
            page_id: 'P1',
            todo_state: 'TODO',
            content: 'call the plumber',
          }),
        ]}
        pageTitles={new Map([['P1', 'My Page']])}
      />,
    )

    expect(screen.getByTestId('query-result-item')).toHaveAttribute(
      'aria-label',
      'TODO call the plumber My Page',
    )
  })

  it('omits the page from the name when the row does not show one', () => {
    // The counterweight: the page arm of the label mirrors the render
    // condition, so a row with no parent page is not named after one.
    render(
      <QueryResultList
        results={[
          makeBlock({
            id: 'B1',
            parent_id: null,
            page_id: 'P1',
            todo_state: null,
            content: 'call the plumber',
          }),
        ]}
        pageTitles={new Map([['P1', 'My Page']])}
      />,
    )

    expect(screen.getByTestId('query-result-item')).toHaveAttribute(
      'aria-label',
      'call the plumber',
    )
  })

  it('resolves the name with no resolveBlockTitle prop — the AdvancedQuery path', () => {
    // `AdvancedQueryView` and `GroupedResults` render this list WITHOUT the
    // prop, and their rows still resolve chips through
    // `useRichContentCallbacks`. Substituting the name through the prop alone
    // therefore left those rows named "follow up on 01KP36KDG2…" beside a chip
    // reading "Quarterly Plan" — the reported bug surviving in the accessible
    // name on half the call sites.
    render(
      <QueryResultList
        results={[
          makeBlock({
            id: 'B1',
            parent_id: 'P1',
            page_id: 'P1',
            content: `follow up on [[${LINKED_PAGE_ID}]]`,
          }),
        ]}
        pageTitles={new Map()}
      />,
    )

    const option = screen.getByTestId('query-result-item')
    expect(option).toHaveAttribute('aria-label', 'follow up on Quarterly Plan')
    expect(option.getAttribute('aria-label')).not.toContain(LINKED_PAGE_ID)
  })

  it('has no a11y violations with a rich row body', async () => {
    // Guards the NEW markup rather than the old bug, so it is green on the
    // pre-fix code by construction. It is falsifiable against the plausible
    // WRONG fix: the content carries a markdown link, and `renderTextInline`
    // gives an external link `role="link"` unconditionally plus `tabIndex={0}`
    // when the surface is interactive. Dropping `interactive: false` therefore
    // puts a focusable link inside the `role="option"` and axe reports
    // `nested-interactive` (verified — a `[[…]]` chip alone does NOT trip the
    // rule, since it carries no widget role).
    const { container } = render(
      <QueryResultList
        results={[
          makeBlock({
            id: 'B1',
            parent_id: 'P1',
            page_id: 'P1',
            content: `follow up on [[${LINKED_PAGE_ID}]] see [docs](https://example.com)`,
          }),
        ]}
        pageTitles={new Map()}
        resolveBlockTitle={resolveTitleProp}
      />,
    )

    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()
  })
})
