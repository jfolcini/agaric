/**
 * Tests for AlertSection shared component.
 *
 * Validates:
 *  - Renders with destructive variant (overdue mode)
 *  - Renders with pending variant (upcoming mode)
 *  - Returns null for empty blocks
 *  - Shows the task checkbox, named with its state, when present
 *  - Shows the priority badge in every variant
 *  - Sorts blocks by due_date ascending
 *  - Navigation on click
 *  - Navigation on keyboard (Enter)
 *  - Does not navigate when parent_id is null
 *  - Renders each block's date as the date chip of its kind ("Jan 15"), never
 *    the raw ISO string, keeping the overdue colour and "(Nd overdue)" text
 *  - Renders content as rich content, so a [[ULID]] page link is a titled
 *    pill and never a raw ULID (#4705)
 *  - Falls back to the empty-content marker for a blank block (#4705)
 *  - Row content is memoized, so a parent re-render does not rebuild it (#4705)
 *  - a11y audit passes (axe) for both variants and empty state
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock as _makeBlock } from '@/__tests__/fixtures'
import { AlertSection } from '@/components/agenda/AlertSection'
import { renderRichContent } from '@/components/RichContentRenderer'
import { t } from '@/lib/i18n'

const LINKED_PAGE_ID = '01KP36KDG2ABCDEFGHJKMNPQRS'

// Spy on the REAL renderer (not a stub) so the rendering assertions below still
// exercise the actual chip markup while the memo test can count the calls.
vi.mock('@/components/RichContentRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/RichContentRenderer')>()
  return { ...actual, renderRichContent: vi.fn(actual.renderRichContent) }
})

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

/** Shared factory + domain defaults for AlertSection tests. */
const makeBlock = (overrides: Parameters<typeof _makeBlock>[0] = {}) =>
  _makeBlock({
    id: 'B1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE1',
    page_id: 'PAGE1',
    todo_state: 'TODO',
    due_date: '2025-01-01',
    ...overrides,
  })

describe('AlertSection', () => {
  const defaultTitles = new Map([['PAGE1', 'My Page']])

  it('renders title and count badge with destructive variant', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('renders title and count badge with pending variant', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('returns null when blocks array is empty', () => {
    const { container } = render(
      <AlertSection variant="destructive" title="Overdue" blocks={[]} pageTitles={new Map()} />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('shows the task checkbox, named with its state, when present (#6544)', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO' })]}
        pageTitles={defaultTitles}
      />,
    )

    const marker = screen.getByRole('button', { name: t('block.taskCycle', { state: 'TODO' }) })
    expect(within(marker).getByTestId('task-checkbox-todo')).toBeInTheDocument()
  })

  // #7040 — a section is a heading over the one task row, not a card per row.
  it('lists its blocks as task rows under a heading, with no card around a row', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]}
        pageTitles={defaultTitles}
      />,
    )

    const rows = screen.getAllByTestId('due-panel-alert-item')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toHaveAttribute('data-block-list-item')
      expect(row).toHaveClass('list-row')
      expect(row.className).not.toMatch(/(^|\s)border(-|\s|$)/)
      expect(row.className).not.toContain('bg-destructive')
    }
    expect(screen.getByRole('heading', { level: 2, name: /^Overdue/ })).toBeInTheDocument()
  })

  it('only the Overdue heading takes the overdue colour', () => {
    const { rerender } = render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1' })]}
        pageTitles={defaultTitles}
      />,
    )
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-alert-error-foreground')

    rerender(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'B1' })]}
        pageTitles={defaultTitles}
      />,
    )
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveClass('text-alert-error-foreground')
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-muted-foreground')
  })

  // The one task row shows a task's priority wherever it is listed (#7040).
  it.each(['destructive', 'pending', 'scheduled'] as const)(
    'shows the priority badge in the %s variant',
    (variant) => {
      render(
        <AlertSection
          variant={variant}
          title="Section"
          blocks={[makeBlock({ id: 'B1', priority: '1' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('P1')).toBeInTheDocument()
    },
  )

  it('sorts blocks by due_date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'later', due_date: '2025-03-01' }),
      makeBlock({ id: 'B2', content: 'earlier', due_date: '2025-01-15' }),
      makeBlock({ id: 'B3', content: 'middle', due_date: '2025-02-01' }),
    ]

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    const items = screen.getAllByText(/earlier|middle|later/)
    expect(items[0]).toHaveTextContent('earlier')
    expect(items[1]).toHaveTextContent('middle')
    expect(items[2]).toHaveTextContent('later')
  })

  it('navigates to parent page on click', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[
          makeBlock({ id: 'BK1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'click me' }),
        ]}
        pageTitles={new Map([['PAGE1', 'Source Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('click me')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BK1')
  })

  it('navigates to parent page on Enter key', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[
          makeBlock({ id: 'BK2', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'key block' }),
        ]}
        pageTitles={new Map([['PAGE1', 'Key Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('key block')
    const li = item.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Key Page', 'BK2')
  })

  it('does not navigate when parent_id is null', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', parent_id: null, page_id: null, content: 'orphan' })]}
        pageTitles={new Map()}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('orphan')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  describe('due date', () => {
    // Pin only `Date` so the compact formatter's same-year / other-year branch
    // is deterministic without freezing timers the render path may use.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2025-06-15T12:00:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('renders due_date as the compact date, not the raw ISO string', () => {
      render(
        <AlertSection
          variant="destructive"
          title="Overdue"
          blocks={[makeBlock({ id: 'B1', due_date: '2025-01-15' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('Jan 15')).toBeInTheDocument()
      expect(screen.queryByText('2025-01-15')).not.toBeInTheDocument()
    })

    it('includes the year for a due date outside the current year', () => {
      render(
        <AlertSection
          variant="pending"
          title="Upcoming"
          blocks={[makeBlock({ id: 'B1', due_date: '2026-01-15' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('Jan 15, 2026')).toBeInTheDocument()
    })

    it('keeps the overdue colour and the "(Nd overdue)" text beside the compact date', () => {
      render(
        <AlertSection
          variant="destructive"
          title="Overdue"
          blocks={[makeBlock({ id: 'B1', due_date: '2025-06-08' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('Jun 8').parentElement).toHaveClass('text-alert-error-foreground')
      expect(screen.getByText('(7d overdue)')).toBeInTheDocument()
    })

    // #7040 — a date is the date chip of its kind, in every section.
    it('draws a due date as the due chip and a scheduled one as the scheduled chip', () => {
      const { container } = render(
        <AlertSection
          variant="scheduled"
          title="Scheduled earlier"
          blocks={[makeBlock({ id: 'B1', due_date: '2099-01-15', scheduled_date: '2025-01-10' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(container.querySelector('[data-date-kind="due"]')).toHaveTextContent('Jan 15, 2099')
      expect(container.querySelector('[data-date-kind="scheduled"]')).toHaveTextContent('Jan 10')
    })
  })

  // #4705 — the row used to render `block.content` through `truncateContent`,
  // which only strips the brackets off a `[[ULID]]` page link, so the row read
  // as a bare ULID. It renders rich content now, same as every other surface.
  it('renders a [[ULID]] page link as a resolved pill, not a raw ULID', () => {
    const { container } = render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', content: `follow up on [[${LINKED_PAGE_ID}]]` })]}
        pageTitles={defaultTitles}
      />,
    )

    const chip = screen.getByTestId('block-link-chip')
    expect(chip).toHaveTextContent('Quarterly Plan')
    expect(container.textContent).not.toContain(LINKED_PAGE_ID)
  })

  // #7040 — the row is the one task row, so its content behaves as in every
  // other group of the panel: a chip in it is a tab stop.
  it('renders the page-link pill as the task row does (interactive)', () => {
    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'B1', content: `see [[${LINKED_PAGE_ID}]]` })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByTestId('block-link-chip')).toHaveAttribute('tabindex', '0')
  })

  // `truncateContent`'s third argument used to supply this; the explicit empty
  // branch replaces it.
  it('shows the empty-content marker for a block with no content', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', content: '' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  // #4705 — DuePanel owns the roving-focus `focusedIndex` and re-renders on
  // every arrow keypress, with Overdue/Upcoming rendered inline (unmemoized,
  // unvirtualized, up to a 200-row page). The row body must not rebuild its
  // element tree on a parent re-render that changed nothing about the row.
  it('does not rebuild row content when the parent re-renders unchanged', () => {
    vi.mocked(renderRichContent).mockClear()
    const first = makeBlock({ id: 'B1', content: 'first' })
    const second = makeBlock({ id: 'B2', content: 'second' })
    const { rerender } = render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[first, second]}
        pageTitles={defaultTitles}
      />,
    )
    expect(renderRichContent).toHaveBeenCalledTimes(2)

    // A FRESH element with equal props, not the same element object: React
    // bails out of an identical element on its own, which would let this pass
    // with no memo at all.
    rerender(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[first, second]}
        pageTitles={defaultTitles}
      />,
    )
    expect(renderRichContent).toHaveBeenCalledTimes(2)

    // A row whose content actually changed still re-renders.
    rerender(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[first, makeBlock({ id: 'B2', content: 'second (edited)' })]}
        pageTitles={defaultTitles}
      />,
    )
    expect(renderRichContent).toHaveBeenCalledTimes(3)
    expect(screen.getByText('second (edited)')).toBeInTheDocument()
  })

  it('a11y: no violations with destructive variant', async () => {
    const { container } = render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', priority: '1', content: 'a11y block' })]}
        pageTitles={defaultTitles}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations with pending variant', async () => {
    const { container } = render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', content: 'a11y block' })]}
        pageTitles={defaultTitles}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations when empty', async () => {
    const { container } = render(
      <AlertSection variant="destructive" title="Overdue" blocks={[]} pageTitles={new Map()} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
