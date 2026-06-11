/**
 * Tests for DaySection component.
 *
 * Validates:
 *  1. Renders day heading with displayDate
 *  2. Hides heading when hideHeading=true
 *  3. Shows "(Today)" badge for today's date
 *  4. Daily mode renders heading as plain text (not clickable)
 *  5. Non-daily mode renders heading as clickable link
 *  6. Clicking heading navigates to daily view for that date
 *  7. Renders BlockTree inside PageBlockStoreProvider when pageId exists
 *  8. Shows full EmptyState when no pageId and not compact
 *  9. Shows compact EmptyState with add-block CTA when no pageId and compact=true
 * 10. Calls onAddBlock when empty-state CTA clicked
 * 11. Calls onAddBlock when compact add button clicked
 * 12. Shows AddBlockButton when pageId exists
 * 13. "Open in editor" button calls onNavigateToPage
 * 14. hideHeading + pageId shows "Open in page editor" link
 * 15. Renders DuePanel, LinkedReferences, DonePanel in daily mode
 * 16. Does NOT render DuePanel/DonePanel in weekly mode
 * 17. Agenda count badges shown in weekly/monthly mode
 * 18. Backlink count badge shown in weekly/monthly mode
 * 19. Count badge click calls goToDateAndPanel
 * 20. Count badge caps at 99+
 * 21. A11y audit passes (axe)
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { format } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: (props: {
    parentId?: string
    autoCreateFirstBlock?: boolean
    onNavigateToPage?: unknown
  }) => (
    <div
      data-testid="block-tree"
      data-parent-id={props.parentId ?? ''}
      data-auto-create={String(!!props.autoCreateFirstBlock)}
      data-on-navigate={String(!!props.onNavigateToPage)}
    >
      BlockTree
    </div>
  ),
}))

// ── Mock DuePanel ───────────────────────────────────────────────────
vi.mock('@/components/agenda/DuePanel', () => ({
  DuePanel: (props: { date: string }) => (
    <div data-testid="due-panel" data-date={props.date}>
      DuePanel
    </div>
  ),
}))

// ── Mock DonePanel ──────────────────────────────────────────────────
vi.mock('@/components/agenda/DonePanel', () => ({
  DonePanel: (props: { date: string }) => (
    <div data-testid="done-panel" data-date={props.date}>
      DonePanel
    </div>
  ),
}))

// ── Mock LinkedReferences ───────────────────────────────────────────
vi.mock('@/components/backlinks/LinkedReferences', () => ({
  LinkedReferences: (props: { pageId: string }) => (
    <div data-testid="linked-references" data-page-id={props.pageId}>
      LinkedReferences
    </div>
  ),
}))

// ── Mock EmptyState ─────────────────────────────────────────────────
vi.mock('@/components/common/EmptyState', () => ({
  EmptyState: ({ message, action }: { message: string; action?: React.ReactNode }) => (
    <div data-testid="empty-state">
      <span>{message}</span>
      {action}
    </div>
  ),
}))

// ── Mock AddBlockButton ─────────────────────────────────────────────
vi.mock('@/components/editor/AddBlockButton', () => ({
  AddBlockButton: ({ onClick }: { onClick: () => void }) => (
    <button data-testid="add-block-button" onClick={onClick} type="button">
      Add block
    </button>
  ),
}))

// ── Mock PageBlockStoreProvider ─────────────────────────────────────
vi.mock('../../../stores/page-blocks', () => ({
  PageBlockStoreProvider: ({ pageId, children }: { pageId: string; children: React.ReactNode }) => (
    <div data-testid="page-block-store-provider" data-page-id={pageId}>
      {children}
    </div>
  ),
}))

// ── Mock UI button ──────────────────────────────────────────────────
// PEND-68 Part A — DaySection now hosts a `ConfirmDialog` via
// `usePageDeleteAction`. The shared `ConfirmDialog` imports
// `buttonVariants` for the destructive-style action button, so the
// mock must export it too (otherwise the dialog throws on first
// render). Returning a no-op string keeps the surface minimal.
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  buttonVariants: () => '',
}))

import type { DayEntry } from '../../../lib/date-utils'
import { useJournalStore } from '../../../stores/journal'
import { DaySection } from '../DaySection'

/** Format a Date as YYYY-MM-DD (mirrors the component's formatDate). */
function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Create a DayEntry with sensible defaults. */
function makeDayEntry(overrides: Partial<DayEntry> = {}): DayEntry {
  const date = overrides.date ?? new Date(2025, 5, 15) // June 15, 2025
  return {
    date,
    dateStr: overrides.dateStr ?? formatDate(date),
    displayDate: overrides.displayDate ?? 'Sun, Jun 15, 2025',
    pageId: overrides.pageId ?? null,
  }
}

const noop = () => {}

beforeEach(() => {
  vi.clearAllMocks()
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(),
    scrollToDate: null,
    scrollToPanel: null,
  })
})

describe('DaySection', () => {
  // 1. Renders day heading with displayDate
  it('renders day heading with displayDate', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    expect(screen.getByText('Sun, Jun 15, 2025')).toBeInTheDocument()
  })

  // 2. Hides heading when hideHeading=true
  it('hides heading when hideHeading=true', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="daily" hideHeading onAddBlock={noop} />)

    expect(screen.queryByText('Sun, Jun 15, 2025')).not.toBeInTheDocument()
  })

  // 3. Shows "(Today)" badge for today's date
  it('shows "(Today)" badge for today\'s date', () => {
    const today = new Date()
    const entry = makeDayEntry({
      date: today,
      dateStr: formatDate(today),
      displayDate: 'Today Display',
    })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    expect(screen.getByText('(Today)')).toBeInTheDocument()
  })

  // 4. Daily mode renders heading as plain text (not clickable)
  it('daily mode renders heading as plain text', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    // In daily mode, isClickable is false, so heading is not a button
    expect(screen.queryByRole('button', { name: /Go to daily view/ })).not.toBeInTheDocument()
    expect(screen.getByText('Sun, Jun 15, 2025')).toBeInTheDocument()
  })

  // 5. Non-daily mode renders heading as clickable link
  it('non-daily mode renders heading as clickable button', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    expect(
      screen.getByRole('button', { name: /Go to daily view for Sun, Jun 15, 2025/ }),
    ).toBeInTheDocument()
  })

  // 6. Clicking heading navigates to daily view for that date
  it('clicking heading navigates to daily view', async () => {
    const user = userEvent.setup()
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })
    const navigateSpy = vi.fn()
    useJournalStore.setState({ navigateToDate: navigateSpy })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    const headingBtn = screen.getByRole('button', {
      name: /Go to daily view for Sun, Jun 15, 2025/,
    })
    await user.click(headingBtn)

    expect(navigateSpy).toHaveBeenCalledWith(entry.date, 'daily')
  })

  // 7. Renders BlockTree inside PageBlockStoreProvider when pageId exists
  it('renders BlockTree when pageId exists', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    const provider = screen.getByTestId('page-block-store-provider')
    expect(provider).toHaveAttribute('data-page-id', 'PAGE_1')

    const tree = within(provider).getByTestId('block-tree')
    expect(tree).toHaveAttribute('data-parent-id', 'PAGE_1')
  })

  // 7b. BlockTree gets autoCreateFirstBlock=true in daily mode
  it('BlockTree gets autoCreateFirstBlock=true in daily mode', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    const tree = screen.getByTestId('block-tree')
    expect(tree).toHaveAttribute('data-auto-create', 'true')
  })

  // 7c. BlockTree gets autoCreateFirstBlock=false in non-daily mode
  it('BlockTree gets autoCreateFirstBlock=false in non-daily mode', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    const tree = screen.getByTestId('block-tree')
    expect(tree).toHaveAttribute('data-auto-create', 'false')
  })

  // 8. Shows full EmptyState when no pageId and not compact
  it('shows full EmptyState when no pageId and not compact', () => {
    const entry = makeDayEntry({ pageId: null, displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No blocks for Sun, Jun 15, 2025/)).toBeInTheDocument()
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
  })

  // 8b. Full EmptyState renders muted hint about slash commands and journal templates
  it('renders muted hint about slash commands and journal templates in full empty state', () => {
    const entry = makeDayEntry({ pageId: null, displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    const hint = screen.getByText('Type / for commands · journal templates configurable per space')
    expect(hint).toBeInTheDocument()
    expect(hint.className).toContain('text-xs')
    expect(hint.className).toContain('text-muted-foreground')
  })

  // 9. Shows compact EmptyState w/ add-block CTA when no pageId and compact=true
  it('shows compact EmptyState with add-block CTA when no pageId and compact=true', () => {
    const entry = makeDayEntry({ pageId: null, displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="weekly" compact onAddBlock={noop} />)

    // Compact mode now uses the EmptyState primitive (UX-3) with an "Add block" action
    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No blocks for Sun, Jun 15, 2025/)).toBeInTheDocument()
    expect(screen.getByText('Add block')).toBeInTheDocument()
  })

  // 10. Calls onAddBlock when empty-state CTA clicked
  it('calls onAddBlock when empty-state CTA clicked', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()
    const entry = makeDayEntry({ pageId: null, dateStr: '2025-06-15' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={onAddBlock} />)

    const addBtn = screen.getByRole('button', { name: /Add your first block/ })
    await user.click(addBtn)

    expect(onAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  // 11. Calls onAddBlock when compact add button clicked
  it('calls onAddBlock when compact add button clicked', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()
    const entry = makeDayEntry({ pageId: null, dateStr: '2025-06-15' })

    render(<DaySection entry={entry} mode="weekly" compact onAddBlock={onAddBlock} />)

    // The compact button has "Add block" text
    const addBtn = screen.getByText('Add block')
    await user.click(addBtn)

    expect(onAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  // 12. Shows AddBlockButton when pageId exists
  it('shows AddBlockButton when pageId exists', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()
    const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={onAddBlock} />)

    const addBtn = screen.getByTestId('add-block-button')
    await user.click(addBtn)

    expect(onAddBlock).toHaveBeenCalledWith('2025-06-15')
  })

  // 13. "Open in editor" button calls onNavigateToPage
  it('"Open in editor" button calls onNavigateToPage', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

    render(
      <DaySection entry={entry} mode="weekly" onAddBlock={noop} onNavigateToPage={onNavigate} />,
    )

    const openBtn = screen.getByRole('button', { name: /Open 2025-06-15 in editor/ })
    await user.click(openBtn)

    expect(onNavigate).toHaveBeenCalledWith('PAGE_1', '2025-06-15')
  })

  // 14. hideHeading + pageId shows "Open in page editor" link
  it('hideHeading + pageId shows "Open in page editor" link', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

    render(
      <DaySection
        entry={entry}
        mode="daily"
        hideHeading
        onAddBlock={noop}
        onNavigateToPage={onNavigate}
      />,
    )

    const openBtn = screen.getByRole('button', { name: /Open 2025-06-15 in editor/ })
    expect(screen.getByText('Open in page editor')).toBeInTheDocument()
    await user.click(openBtn)

    expect(onNavigate).toHaveBeenCalledWith('PAGE_1', '2025-06-15')
  })

  // 15. Renders DuePanel, LinkedReferences, DonePanel in daily mode
  it('renders DuePanel, LinkedReferences, DonePanel in daily mode', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    expect(screen.getByTestId('due-panel')).toHaveAttribute('data-date', '2025-06-15')
    expect(screen.getByTestId('linked-references')).toHaveAttribute('data-page-id', 'PAGE_1')
    expect(screen.getByTestId('done-panel')).toHaveAttribute('data-date', '2025-06-15')
  })

  // 16. Does NOT render DuePanel/DonePanel in weekly mode
  it('does NOT render DuePanel/DonePanel in weekly mode', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('done-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
  })

  // 17. Agenda count badges shown in weekly/monthly mode
  it('renders agenda count badges in weekly mode', () => {
    const entry = makeDayEntry({ dateStr: '2025-06-15', displayDate: 'Sun, Jun 15, 2025' })
    const agendaCountsBySource = {
      '2025-06-15': { 'column:due_date': 3, 'column:scheduled_date': 2 },
    }

    render(
      <DaySection
        entry={entry}
        mode="weekly"
        agendaCountsBySource={agendaCountsBySource}
        onAddBlock={noop}
      />,
    )

    // Use aria-labels for precise badge targeting (text queries match too broadly)
    const dueBadge = screen.getByLabelText('3 Due items, click to view')
    expect(dueBadge).toBeInTheDocument()
    expect(dueBadge).toHaveTextContent(/3/)
    expect(dueBadge).toHaveTextContent(/Due/)

    const scheduledBadge = screen.getByLabelText('2 Scheduled items, click to view')
    expect(scheduledBadge).toBeInTheDocument()
    expect(scheduledBadge).toHaveTextContent(/2/)
    expect(scheduledBadge).toHaveTextContent(/Scheduled/)
  })

  // 18. Backlink count badge shown in weekly/monthly mode
  it('renders backlink count badge in weekly mode', () => {
    const entry = makeDayEntry({
      pageId: 'PAGE_1',
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })
    const backlinkCounts = { PAGE_1: 5 }

    render(
      <DaySection entry={entry} mode="weekly" backlinkCounts={backlinkCounts} onAddBlock={noop} />,
    )

    const refBadge = screen.getByLabelText('5 references, click to view')
    expect(refBadge).toBeInTheDocument()
    expect(refBadge).toHaveTextContent(/5/)
    expect(refBadge).toHaveTextContent(/refs/)
  })

  // 19. Count badge click calls goToDateAndPanel
  it('count badge click calls goToDateAndPanel', async () => {
    const user = userEvent.setup()
    const goToDateAndPanelSpy = vi.fn()
    useJournalStore.setState({ goToDateAndPanel: goToDateAndPanelSpy })

    const entry = makeDayEntry({
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })
    const agendaCountsBySource = {
      '2025-06-15': { 'column:due_date': 3 },
    }

    render(
      <DaySection
        entry={entry}
        mode="weekly"
        agendaCountsBySource={agendaCountsBySource}
        onAddBlock={noop}
      />,
    )

    const badge = screen.getByLabelText('3 Due items, click to view')
    await user.click(badge)

    expect(goToDateAndPanelSpy).toHaveBeenCalledWith(entry.date, 'due')
  })

  // 19b. Backlink badge click calls goToDateAndPanel('references')
  it('backlink badge click calls goToDateAndPanel', async () => {
    const user = userEvent.setup()
    const goToDateAndPanelSpy = vi.fn()
    useJournalStore.setState({ goToDateAndPanel: goToDateAndPanelSpy })

    const entry = makeDayEntry({
      pageId: 'PAGE_1',
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })
    const backlinkCounts = { PAGE_1: 5 }

    render(
      <DaySection entry={entry} mode="weekly" backlinkCounts={backlinkCounts} onAddBlock={noop} />,
    )

    const badge = screen.getByLabelText('5 references, click to view')
    await user.click(badge)

    expect(goToDateAndPanelSpy).toHaveBeenCalledWith(entry.date, 'references')
  })

  // 20. Count badge caps at 99+
  it('count badge caps at 99+', () => {
    const entry = makeDayEntry({ dateStr: '2025-06-15', displayDate: 'Sun, Jun 15, 2025' })
    const agendaCountsBySource = {
      '2025-06-15': { 'column:due_date': 150 },
    }

    render(
      <DaySection
        entry={entry}
        mode="weekly"
        agendaCountsBySource={agendaCountsBySource}
        onAddBlock={noop}
      />,
    )

    expect(screen.getByText(/99\+/)).toBeInTheDocument()
  })

  // 20b. Backlink count badge caps at 99+
  it('backlink count badge caps at 99+', () => {
    const entry = makeDayEntry({
      pageId: 'PAGE_1',
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })
    const backlinkCounts = { PAGE_1: 200 }

    render(
      <DaySection entry={entry} mode="weekly" backlinkCounts={backlinkCounts} onAddBlock={noop} />,
    )

    expect(screen.getByText(/99\+/)).toBeInTheDocument()
  })

  // 21. section has correct aria-label
  it('section has correct aria-label', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    expect(
      screen.getByRole('region', { name: 'Journal for Sun, Jun 15, 2025' }),
    ).toBeInTheDocument()
  })

  // 22. Does not render "open in editor" button without onNavigateToPage
  it('does not show "Open in editor" without onNavigateToPage', () => {
    const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    expect(screen.queryByRole('button', { name: /Open.*in editor/ })).not.toBeInTheDocument()
  })

  // 23. Does not render count badges in daily mode
  it('does not render count badges in daily mode', () => {
    const entry = makeDayEntry({ dateStr: '2025-06-15' })
    const agendaCountsBySource = {
      '2025-06-15': { 'column:due_date': 3 },
    }

    render(
      <DaySection
        entry={entry}
        mode="daily"
        agendaCountsBySource={agendaCountsBySource}
        onAddBlock={noop}
      />,
    )

    expect(screen.queryByLabelText(/items, click to view/)).not.toBeInTheDocument()
  })

  // 24. Does not render count badges in agenda mode
  it('does not render count badges in agenda mode', () => {
    const entry = makeDayEntry({ dateStr: '2025-06-15' })
    const agendaCountsBySource = {
      '2025-06-15': { 'column:due_date': 3 },
    }

    render(
      <DaySection
        entry={entry}
        mode="agenda"
        agendaCountsBySource={agendaCountsBySource}
        onAddBlock={noop}
      />,
    )

    expect(screen.queryByLabelText(/items, click to view/)).not.toBeInTheDocument()
  })

  // 25. Today highlight: isToday applies strengthened highlight classes
  it('applies strengthened highlight classes when isToday is true', () => {
    const today = new Date()
    const entry = makeDayEntry({
      date: today,
      dateStr: formatDate(today),
      displayDate: 'Today Display',
    })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    const section = screen.getByRole('region', { name: 'Journal for Today Display' })
    expect(section.className).toContain('bg-accent/[0.08]')
    expect(section.className).not.toContain('border-l-2')
    expect(section.className).not.toContain('border-accent')
  })

  // 26. Non-today: does NOT have highlight classes
  it('does NOT apply highlight classes when isToday is false', () => {
    const entry = makeDayEntry({
      date: new Date(2025, 5, 15),
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    const section = screen.getByRole('region', { name: 'Journal for Sun, Jun 15, 2025' })
    expect(section.className).not.toContain('bg-accent/[0.08]')
    expect(section.className).not.toContain('border-l-2')
    expect(section.className).not.toContain('border-accent')
  })

  // 27. PEND-28 M8: heading row uses flex-wrap so badges + open-in-editor
  // button don't run off the right edge on narrow phones.
  it('heading row uses flex-wrap to prevent overflow on phones', () => {
    const entry = makeDayEntry({ displayDate: 'Sun, Jun 15, 2025' })

    render(<DaySection entry={entry} mode="weekly" onAddBlock={noop} />)

    const heading = screen.getByText('Sun, Jun 15, 2025')
    const row = heading.closest('div.flex')
    expect(row).not.toBeNull()
    expect(row?.className).toContain('flex-wrap')
  })

  // A11y: no violations (with content)
  it('a11y: no violations with content', async () => {
    const entry = makeDayEntry({
      pageId: 'PAGE_1',
      dateStr: '2025-06-15',
      displayDate: 'Sun, Jun 15, 2025',
    })

    const { container } = render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // A11y: no violations (empty state)
  it('a11y: no violations in empty state', async () => {
    const entry = makeDayEntry({
      pageId: null,
      displayDate: 'Sun, Jun 15, 2025',
    })

    const { container } = render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── PEND-68 Part A — page-quick-actions (star + delete) ───────────
  describe('PageQuickActions integration', () => {
    // The shared `Button` mock at the top of this file flattens
    // `IconButton` to a bare `<button>` (it passes through children +
    // props). The Tooltip wrapper inside IconButton renders unchanged
    // — we query by aria-label, not tooltip text.

    it('renders star + delete in the weekly/monthly header when entry.pageId is set', () => {
      const entry = makeDayEntry({ pageId: 'PAGE_1', displayDate: 'Sun, Jun 15, 2025' })

      render(
        <DaySection entry={entry} mode="weekly" onAddBlock={noop} onNavigateToPage={() => {}} />,
      )

      expect(screen.getByRole('button', { name: /star this page/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete page/i })).toBeInTheDocument()
    })

    it('renders star + delete in the daily-mode (hideHeading) header when entry.pageId is set', () => {
      const entry = makeDayEntry({ pageId: 'PAGE_1', dateStr: '2025-06-15' })

      render(
        <DaySection
          entry={entry}
          mode="daily"
          hideHeading
          onAddBlock={noop}
          onNavigateToPage={() => {}}
        />,
      )

      expect(screen.getByRole('button', { name: /star this page/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete page/i })).toBeInTheDocument()
    })

    it('does NOT render star/delete when entry.pageId is null (auto-create placeholder)', () => {
      const entry = makeDayEntry({ pageId: null, displayDate: 'Sun, Jun 15, 2025' })

      render(
        <DaySection entry={entry} mode="weekly" onAddBlock={noop} onNavigateToPage={() => {}} />,
      )

      // No star, no delete — only the empty-state CTA is visible.
      expect(screen.queryByRole('button', { name: /star this page/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /delete page/i })).not.toBeInTheDocument()
    })

    it('clicking delete opens the confirm dialog with the journal-specific copy', async () => {
      const user = userEvent.setup()
      const entry = makeDayEntry({ pageId: 'PAGE_1', displayDate: 'Sun, Jun 15, 2025' })

      render(
        <DaySection entry={entry} mode="weekly" onAddBlock={noop} onNavigateToPage={() => {}} />,
      )

      await user.click(screen.getByRole('button', { name: /delete page/i }))

      // Journal-specific title interpolates the displayDate.
      expect(await screen.findByText('Delete the note for Sun, Jun 15, 2025?')).toBeInTheDocument()
      // Description references Trash + Undo.
      expect(screen.getByText(/moves the day's note .* to Trash/i)).toBeInTheDocument()
    })
  })

  // ── Lazy-mount (perf-review Tier 2 item 7) ─────────────────────────
  describe('lazyMount', () => {
    /**
     * Per-test IntersectionObserver mock. The shared test-setup.ts ships a
     * no-op stub that never reports intersection — fine for components that
     * tolerate "never intersects" but not for asserting the swap-in. We
     * install a controllable mock and uninstall in `afterEach`.
     */
    type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

    class MockIntersectionObserver {
      callback: IOCallback
      rootMargin: string
      observed: Set<Element> = new Set()
      static instances: MockIntersectionObserver[] = []

      constructor(callback: IOCallback, options?: IntersectionObserverInit) {
        this.callback = callback
        this.rootMargin = options?.rootMargin ?? '0px'
        MockIntersectionObserver.instances.push(this)
      }

      observe(el: Element): void {
        this.observed.add(el)
      }
      unobserve(el: Element): void {
        this.observed.delete(el)
      }
      disconnect(): void {
        this.observed.clear()
      }
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      /** Trigger an `isIntersecting: true` callback for all observed elements. */
      enterAll(): void {
        const entries = Array.from(this.observed).map(
          (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
        )
        this.callback(entries, this as unknown as IntersectionObserver)
      }
    }

    beforeEach(() => {
      MockIntersectionObserver.instances = []
      vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    // Default behaviour (lazyMount=false, today's default) — BlockTree mounts
    // immediately, no placeholder. This is the path used by DailyView.
    it('mounts BlockTree eagerly when lazyMount is not set (default)', () => {
      const entry = makeDayEntry({ pageId: 'PAGE_1' })

      render(<DaySection entry={entry} mode="daily" onAddBlock={noop} />)

      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
      expect(screen.queryByTestId('day-section-lazy-placeholder')).not.toBeInTheDocument()
    })

    // Lazy path before viewport entry: a placeholder renders in place of
    // BlockTree until IntersectionObserver fires.
    it('renders placeholder until IntersectionObserver reports entry', () => {
      const entry = makeDayEntry({
        pageId: 'PAGE_1',
        dateStr: '2025-06-15',
        displayDate: 'Sun, Jun 15, 2025',
      })

      render(<DaySection entry={entry} mode="weekly" lazyMount onAddBlock={noop} />)

      // Placeholder is there, BlockTree is NOT.
      const placeholder = screen.getByTestId('day-section-lazy-placeholder')
      expect(placeholder).toBeInTheDocument()
      expect(placeholder).toHaveAttribute('data-date', '2025-06-15')
      expect(placeholder).toHaveAttribute('aria-hidden', 'true')
      expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()

      // The observer was wired up and is observing the placeholder element.
      expect(MockIntersectionObserver.instances).toHaveLength(1)
      const obs = MockIntersectionObserver.instances[0]
      expect(obs).toBeDefined()
      expect(obs?.observed.size).toBe(1)
    })

    // After the observer fires `isIntersecting: true`, the placeholder is
    // swapped for the full BlockTree. Once mounted, it stays mounted (the
    // observer disconnects in the same callback).
    it('swaps placeholder for BlockTree after observer fires', async () => {
      const entry = makeDayEntry({
        pageId: 'PAGE_1',
        dateStr: '2025-06-15',
        displayDate: 'Sun, Jun 15, 2025',
      })

      render(<DaySection entry={entry} mode="weekly" lazyMount onAddBlock={noop} />)

      // Sanity: placeholder rendered first.
      expect(screen.getByTestId('day-section-lazy-placeholder')).toBeInTheDocument()

      const obs = MockIntersectionObserver.instances[0]
      expect(obs).toBeDefined()

      act(() => {
        obs?.enterAll()
      })

      // Placeholder swapped for the real tree.
      await waitFor(() => {
        expect(screen.queryByTestId('day-section-lazy-placeholder')).not.toBeInTheDocument()
        expect(screen.getByTestId('block-tree')).toBeInTheDocument()
      })
    })

    // Reduced-motion path: lazyMount=true but the user prefers reduced
    // motion → eagerly mount (avoid the visible placeholder→tree swap on
    // scroll).
    it('eagerly mounts under prefers-reduced-motion even when lazyMount=true', () => {
      const originalMatchMedia = window.matchMedia
      try {
        // oxlint-disable-next-line typescript/no-explicit-any -- targeted matchMedia stub
        ;(window as any).matchMedia = (query: string) => ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        })

        const entry = makeDayEntry({ pageId: 'PAGE_1' })

        render(<DaySection entry={entry} mode="weekly" lazyMount onAddBlock={noop} />)

        expect(screen.getByTestId('block-tree')).toBeInTheDocument()
        expect(screen.queryByTestId('day-section-lazy-placeholder')).not.toBeInTheDocument()
      } finally {
        // oxlint-disable-next-line typescript/no-explicit-any -- restore matchMedia
        ;(window as any).matchMedia = originalMatchMedia
      }
    })

    // Edge case: lazyMount with no pageId → no BlockTree to mount at all,
    // and we should not render a phantom placeholder. The empty-state path
    // handles the "no content" UX.
    it('does not render placeholder when pageId is null', () => {
      const entry = makeDayEntry({ pageId: null, displayDate: 'Sun, Jun 15, 2025' })

      render(<DaySection entry={entry} mode="weekly" compact lazyMount onAddBlock={noop} />)

      expect(screen.queryByTestId('day-section-lazy-placeholder')).not.toBeInTheDocument()
      expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
      // Empty state still rendered.
      expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    })
  })
})
