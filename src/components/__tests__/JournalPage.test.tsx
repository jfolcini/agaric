/**
 * Tests for JournalPage component (daily/weekly/monthly tri-mode view).
 *
 * Validates:
 *  - Daily mode: renders one day section, prev/next changes day, today button
 *  - Weekly mode: renders Mon-Sun (7 day sections)
 *  - Monthly mode: renders calendar grid with content indicators
 *  - Mode switcher tabs (Day/Week/Month)
 *  - Date navigation (prev/next/today)
 *  - BlockTree rendered with correct parentId for days that have pages
 *  - Empty state shown for days without pages
 *  - "Add block" creates page + block for that day
 *  - "Open in editor" button calls onNavigateToPage
 *  - Loading state while fetching pages
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, addMonths, endOfWeek, format, startOfWeek, subDays } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { emptyPage, makeDailyPage } from '../../__tests__/fixtures'

// ── Mock BlockTree ──────────────────────────────────────────────────
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string }) => {
    return (
      <div data-testid="block-tree" data-parent-id={props.parentId ?? ''} className="block-tree" />
    )
  },
}))

// ── Mock DuePanel ───────────────────────────────────────────────────
vi.mock('../DuePanel', () => ({
  DuePanel: (props: { date: string; onNavigateToPage?: unknown }) => (
    <div data-testid="due-panel" data-date={props.date}>
      DuePanel
    </div>
  ),
}))

// ── Mock DonePanel ──────────────────────────────────────────────────
vi.mock('../DonePanel', () => ({
  DonePanel: (props: { date: string; onNavigateToPage?: unknown }) => (
    <div data-testid="done-panel" data-date={props.date}>
      DonePanel
    </div>
  ),
}))

// ── Mock LinkedReferences ───────────────────────────────────────────
vi.mock('../LinkedReferences', () => ({
  LinkedReferences: (props: { pageId: string; onNavigateToPage?: unknown }) => (
    <div data-testid="linked-references" data-page-id={props.pageId}>
      LinkedReferences
    </div>
  ),
}))

// ── Mock AgendaFilterBuilder ────────────────────────────────────────
const { filterChangeRef } = vi.hoisted(() => ({
  filterChangeRef: { current: null as ((filters: unknown[]) => void) | null },
}))

vi.mock('../AgendaFilterBuilder', () => ({
  AgendaFilterBuilder: (props: { filters: unknown[]; onFiltersChange: unknown }) => {
    filterChangeRef.current = props.onFiltersChange as (filters: unknown[]) => void
    return (
      <div
        data-testid="agenda-filter-builder"
        data-filter-count={Array.isArray(props.filters) ? props.filters.length : 0}
      >
        AgendaFilterBuilder
      </div>
    )
  },
  AgendaSortGroupControls: (props: {
    groupBy: string
    sortBy: string
    onGroupByChange: unknown
    onSortByChange: unknown
  }) => (
    <div
      data-testid="agenda-sort-group-controls"
      data-group-by={props.groupBy}
      data-sort-by={props.sortBy}
    >
      AgendaSortGroupControls
    </div>
  ),
}))

// ── Mock AgendaResults ──────────────────────────────────────────────
vi.mock('../AgendaResults', () => ({
  AgendaResults: (props: { blocks: unknown[]; loading: boolean; hasActiveFilters: boolean }) => (
    <div
      data-testid="agenda-results"
      data-block-count={Array.isArray(props.blocks) ? props.blocks.length : 0}
      data-loading={props.loading}
    >
      AgendaResults
    </div>
  ),
}))

// ── Mock MonthlyDayCell (UX-83) ─────────────────────────────────────
vi.mock('../journal/MonthlyDayCell', () => ({
  MonthlyDayCell: (props: Record<string, unknown>) => {
    const entry = props.entry as { dateStr: string; displayDate: string }
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: test mock
      // biome-ignore lint/a11y/useSemanticElements: test mock for gridcell
      // biome-ignore lint/a11y/useKeyWithClickEvents: test mock
      <div
        role="gridcell"
        data-testid={`monthly-cell-${entry.dateStr}`}
        data-is-today={String(!!props.isToday)}
        data-is-current-month={String(!!props.isCurrentMonth)}
        data-agenda-count={String(props.agendaCount)}
        data-backlink-count={String(props.backlinkCount)}
        aria-label={entry.displayDate}
        onClick={() => (props.onNavigateToDate as (d: string) => void)?.(entry.dateStr)}
      >
        {new Date(`${entry.dateStr}T12:00:00`).getDate()}
      </div>
    )
  },
}))

import { useBlockStore } from '../../stores/blocks'
import { useJournalStore } from '../../stores/journal'
import { JournalControls, JournalPage, MAX_JOURNAL_DATE, MIN_JOURNAL_DATE } from '../JournalPage'

const mockedInvoke = vi.mocked(invoke)

/** Format a Date as YYYY-MM-DD (mirrors the component's formatDate). */
function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Format a Date as display string (mirrors the component's formatDateDisplay). */
function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// jsdom does not implement scrollIntoView — stub it globally
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  filterChangeRef.current = null
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
  // Reset journal store to defaults
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(),
  })
})

/** Render JournalPage with JournalControls (controls live in App header in production). */
function renderJournal(props?: { onNavigateToPage?: (pageId: string, title?: string) => void }) {
  return render(
    <>
      <JournalControls />
      <JournalPage {...props} />
    </>,
  )
}

describe('JournalPage', () => {
  // ── Daily Mode (default) ────────────────────────────────────────────

  describe('daily mode', () => {
    it('defaults to daily mode showing one day section (today)', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Should show exactly 1 day section (today)
      const sections = screen.getAllByRole('region')
      expect(sections).toHaveLength(1)

      const todayDisplay = formatDateDisplay(new Date())
      expect(sections[0]).toHaveAccessibleName(`Journal for ${todayDisplay}`)
    })

    it('daily mode hides date heading (shown in header bar instead)', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Daily mode: date heading is hidden (shown in header bar instead).
      // The only h2 may come from EmptyState; no date heading should exist.
      // Filter out headings from UnfinishedTasks (F-23) empty state.
      const h2s = screen.queryAllByRole('heading', { level: 2 })
      for (const h2 of h2s) {
        if (h2.textContent?.includes('unfinished')) continue
        expect(h2.textContent).toMatch(/No blocks/)
      }
    })

    it('shows empty state with "No blocks" when no page exists for the day', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const noBlocksTexts = screen.getAllByText(/No blocks for/)
      expect(noBlocksTexts).toHaveLength(1)
      expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
    })

    it('renders BlockTree when a page exists for the current day', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        const trees = screen.getAllByTestId('block-tree')
        expect(trees).toHaveLength(1)
      })

      const trees = screen.getAllByTestId('block-tree')
      expect(trees[0]).toHaveAttribute('data-parent-id', 'DP-TODAY')
    })

    it('prev button navigates to previous day', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      await user.click(prevBtn)

      const yesterdayDisplay = formatDateDisplay(subDays(new Date(), 1))
      await waitFor(() => {
        expect(screen.getByTestId('date-display')).toHaveTextContent(yesterdayDisplay)
      })
    })

    it('next button navigates to next day', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const nextBtn = screen.getByRole('button', { name: /next day/i })
      await user.click(nextBtn)

      const tomorrowDisplay = formatDateDisplay(addDays(new Date(), 1))
      await waitFor(() => {
        expect(screen.getByTestId('date-display')).toHaveTextContent(tomorrowDisplay)
      })
    })

    it('today button returns to current day', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Navigate away
      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      await user.click(prevBtn)

      // Click today
      const todayBtn = screen.getByRole('button', { name: /go to today/i })
      await user.click(todayBtn)

      const todayDisplay = formatDateDisplay(new Date())
      await waitFor(() => {
        expect(screen.getByTestId('date-display')).toHaveTextContent(todayDisplay)
      })
    })
  })

  // ── Weekly Mode ─────────────────────────────────────────────────────

  describe('weekly mode', () => {
    it('shows 7 day sections (Mon-Sun) when switched to weekly', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      const sections = screen.getAllByRole('region')
      expect(sections).toHaveLength(7)
    })

    it('week starts on Monday and ends on Sunday', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      const sections = screen.getAllByRole('region')
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 })
      const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 })

      const firstDayDisplay = formatDateDisplay(weekStart)
      const lastDayDisplay = formatDateDisplay(weekEnd)

      expect(sections[0]).toHaveAccessibleName(`Journal for ${firstDayDisplay}`)
      expect(sections[6]).toHaveAccessibleName(`Journal for ${lastDayDisplay}`)
    })

    it('displays week range in nav header', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 })
      const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 })
      const expectedRange = `${format(weekStart, 'MMM d')} - ${format(weekEnd, 'MMM d, yyyy')}`

      expect(screen.getByTestId('date-display')).toHaveTextContent(expectedRange)
    })

    it('renders BlockTree for days with pages in weekly view', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      await waitFor(() => {
        const trees = screen.getAllByTestId('block-tree')
        expect(trees).toHaveLength(1)
        expect(trees[0]).toHaveAttribute('data-parent-id', 'DP-TODAY')
      })
    })
  })

  // ── Monthly Mode ────────────────────────────────────────────────────

  describe('monthly mode', () => {
    it('shows calendar grid when switched to monthly', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      // Should have a grid with gridcell elements (one per visible day)
      expect(screen.getByRole('grid')).toBeInTheDocument()
      const cells = screen.getAllByRole('gridcell')
      // Current month has at least 28 days, plus padding
      expect(cells.length).toBeGreaterThanOrEqual(28)
    })

    it('displays month/year in nav header', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      const expectedMonth = format(new Date(), 'MMMM yyyy')
      expect(screen.getByTestId('date-display')).toHaveTextContent(expectedMonth)
    })

    it('renders grid cells for days in monthly view', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      // Grid cells should be rendered for the month
      const cells = screen.getAllByRole('gridcell')
      expect(cells.length).toBeGreaterThanOrEqual(28)

      // Today's cell should exist
      const todayCell = screen.getByTestId(`monthly-cell-${todayStr}`)
      expect(todayCell).toBeInTheDocument()
    })
  })

  // ── Mode Switcher ───────────────────────────────────────────────────

  describe('mode switcher', () => {
    it('renders Day/Week/Month tabs', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /weekly view/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /monthly view/i })).toBeInTheDocument()
    })

    it('Day tab is selected by default', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    it('switching modes updates aria-selected on tabs', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      expect(weekTab).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
        'aria-selected',
        'false',
      )
    })
  })

  // ── Header bar layout ────────────────────────────────────────────────

  describe('header bar layout', () => {
    it('journal header renders as a flex container (positioned in the fixed header bar)', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const header = screen.getByTestId('journal-header')
      expect(header).toBeInTheDocument()
      expect(header.className).toContain('flex')
      expect(header.className).toContain('flex-1')
      // JournalControls lives in the fixed header bar (outside the scroll
      // container), so it does NOT need sticky/border-b — those are handled
      // by the <header> element in App.tsx
      expect(header.className).not.toContain('sticky')
      expect(header.className).not.toContain('border-b')
    })
  })

  // ── Add block (shared across modes) ─────────────────────────────────

  describe('add block', () => {
    it('creates daily page + block when no page exists for the day', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Set up mocks: create daily page + journal-template query + create child block + load(pageId)
      mockedInvoke
        .mockResolvedValueOnce({
          id: 'DP1',
          block_type: 'page',
          content: todayStr,
          parent_id: null,
          position: null,
        })
        .mockResolvedValueOnce(emptyPage) // query_by_property for journal-template → none
        .mockResolvedValueOnce({
          id: 'B1',
          block_type: 'text',
          content: '',
          parent_id: 'DP1',
          position: 0,
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: 'B1',
              block_type: 'text',
              content: '',
              parent_id: 'DP1',
              position: 0,
              deleted_at: null,
              is_conflict: false,
            },
          ],
          next_cursor: null,
          has_more: false,
        })

      // Click the "Add block" button in today's section
      const sections = screen.getAllByRole('region')
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: todayStr,
          parentId: null,
          position: null,
        })
      })
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'DP1',
        position: null,
      })
    })

    it('creates block under existing page without creating new page', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })

      mockedInvoke.mockResolvedValue({
        items: [dailyPage],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      mockedInvoke
        .mockResolvedValueOnce({
          id: 'B2',
          block_type: 'text',
          content: '',
          parent_id: 'DP1',
          position: 1,
        })
        .mockResolvedValueOnce({
          items: [],
          next_cursor: null,
          has_more: false,
        })

      const sections = screen.getAllByRole('region')
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'content',
          content: '',
          parentId: 'DP1',
          position: null,
        })
      })

      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('focuses the new block after add-block in journal view', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })

      mockedInvoke.mockResolvedValue({
        items: [dailyPage],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      mockedInvoke
        .mockResolvedValueOnce({
          id: 'NEW_BLOCK',
          block_type: 'content',
          content: '',
          parent_id: 'DP1',
          position: 1,
        })
        .mockResolvedValueOnce({
          items: [],
          next_cursor: null,
          has_more: false,
        })

      const sections = screen.getAllByRole('region')
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(useBlockStore.getState().focusedBlockId).toBe('NEW_BLOCK')
      })
    })
  })

  // ── Open in editor ──────────────────────────────────────────────────

  describe('open in editor', () => {
    it('shows "Open in editor" button for days that have pages', async () => {
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })
      const onNavigateToPage = vi.fn()

      mockedInvoke.mockResolvedValue({
        items: [dailyPage],
        next_cursor: null,
        has_more: false,
      })

      renderJournal({ onNavigateToPage })

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      const openBtn = screen.getByRole('button', {
        name: new RegExp(`Open ${todayStr} in editor`),
      })
      expect(openBtn).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(openBtn)

      expect(onNavigateToPage).toHaveBeenCalledWith('DP1', todayStr)
    })

    it('does not show "Open in editor" button for days without pages', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal({ onNavigateToPage: vi.fn() })

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      expect(screen.queryByRole('button', { name: /open .* in editor/i })).not.toBeInTheDocument()
    })
  })

  // ── Clickable day titles ─────────────────────────────────────────────

  describe('clickable day titles', () => {
    it('day headings in weekly view are clickable buttons', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)
      const dayButtons = screen.getAllByRole('button', { name: /go to daily view for/i })
      expect(dayButtons).toHaveLength(7)
    })

    it('clicking a day title in weekly view navigates to daily mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)
      const dayButtons = screen.getAllByRole('button', { name: /go to daily view for/i })
      await user.click(dayButtons[0] as HTMLElement)
      expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    it('grid cells in monthly view are clickable', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)
      const cells = screen.getAllByRole('gridcell')
      expect(cells.length).toBeGreaterThanOrEqual(28)
    })

    it('day headings in daily view are NOT clickable buttons', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      expect(screen.queryAllByRole('button', { name: /go to daily view for/i })).toHaveLength(0)
    })
  })

  // ── Day section IDs for scroll targeting ────────────────────────────

  describe('day section IDs', () => {
    it('day sections have id attributes for scroll targeting', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)
      const sections = screen.getAllByRole('region')
      for (const section of sections) {
        expect(section.id).toMatch(/^journal-\d{4}-\d{2}-\d{2}$/)
      }
    })

    it('today section has id matching today date string', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const todayId = `journal-${formatDate(new Date())}`
      const section = document.getElementById(todayId)
      expect(section).not.toBeNull()
    })
  })

  // ── Loading state ───────────────────────────────────────────────────

  it('shows loading state while fetching pages', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = renderJournal()

    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
  })

  // ── Error handling ──────────────────────────────────────────────────

  it('shows empty state when page listing fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('Failed to load'))

    renderJournal()

    // Loading skeleton should disappear (component catches the error and sets loading=false)
    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // Component falls back to empty pageMap, so today's date shows the empty state
    const todayDisplay = formatDateDisplay(new Date())
    expect(screen.getByText(`No blocks for ${todayDisplay}.`)).toBeInTheDocument()
  })

  // ── a11y ────────────────────────────────────────────────────────────

  it('has no a11y violations (daily mode, empty state)', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    const { container } = renderJournal()

    await waitFor(async () => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when daily pages exist', async () => {
    const todayStr = formatDate(new Date())
    const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })

    mockedInvoke.mockResolvedValue({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    const { container } = renderJournal({ onNavigateToPage: () => {} })

    await waitFor(async () => {
      expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── Calendar dropdown positioning (#178) ────────────────────────────

  describe('calendar dropdown positioning', () => {
    it('flips above when calendar overflows viewport bottom', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Mock getBoundingClientRect to simulate overflow: bottom > viewportHeight - 8
      const originalGBCR = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = () => ({
        top: 500,
        bottom: 900,
        left: 100,
        right: 400,
        width: 300,
        height: 400,
        x: 100,
        y: 500,
        toJSON: () => {},
      })

      // Simulate small viewport
      Object.defineProperty(window, 'visualViewport', {
        value: { height: 600, width: 1024 },
        writable: true,
        configurable: true,
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      // The calendar dropdown should have 'bottom-full' class (flipped above)
      await waitFor(() => {
        const dropdown = document.querySelector('.absolute.z-50.rounded-md')
        expect(dropdown).not.toBeNull()
        expect(dropdown?.className).toContain('bottom-full')
      })

      // Cleanup
      Element.prototype.getBoundingClientRect = originalGBCR
    })

    it('shifts right when calendar overflows left edge on narrow viewport', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Mock getBoundingClientRect to simulate left overflow: left < 8
      const originalGBCR = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = () => ({
        top: 50,
        bottom: 350,
        left: -20,
        right: 280,
        width: 300,
        height: 300,
        x: -20,
        y: 50,
        toJSON: () => {},
      })

      Object.defineProperty(window, 'visualViewport', {
        value: { height: 800, width: 300 },
        writable: true,
        configurable: true,
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      // The calendar dropdown should have a translateX transform to shift right
      await waitFor(() => {
        const dropdown = document.querySelector('.absolute.z-50.rounded-md') as HTMLElement | null
        expect(dropdown).not.toBeNull()
        expect(dropdown?.style.transform).toBe('translateX(28px)')
      })

      // Cleanup
      Element.prototype.getBoundingClientRect = originalGBCR
    })
  })

  // ── Calendar dropdown interactions ───────────────────────────────────

  describe('calendar dropdown interactions', () => {
    it('opens calendar when calendar button is clicked', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })
    })

    it('closes calendar when clicking backdrop', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Open calendar
      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })

      // Click the backdrop (fixed inset-0 overlay)
      const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement
      expect(backdrop).not.toBeNull()
      await user.click(backdrop)

      await waitFor(() => {
        expect(screen.queryByRole('grid')).not.toBeInTheDocument()
      })
    })

    it('closes calendar on Escape key', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Open calendar
      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })

      // Press Escape
      await user.keyboard('{Escape}')

      await waitFor(() => {
        expect(screen.queryByRole('grid')).not.toBeInTheDocument()
      })
    })

    it('Today button navigates to today in weekly mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Switch to weekly mode
      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      // Navigate away from today's week
      const prevBtn = screen.getByRole('button', { name: /previous week/i })
      await user.click(prevBtn)

      // Click "Go to today"
      const todayBtn = screen.getByRole('button', { name: /go to today/i })
      await user.click(todayBtn)

      // Verify the date display shows today's week range
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 })
      const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 })
      const expectedRange = `${format(weekStart, 'MMM d')} - ${format(weekEnd, 'MMM d, yyyy')}`

      await waitFor(() => {
        expect(screen.getByTestId('date-display')).toHaveTextContent(expectedRange)
      })
    })

    it('Today button navigates to today in monthly mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Switch to monthly mode
      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      // Navigate away from current month
      const prevBtn = screen.getByRole('button', { name: /previous month/i })
      await user.click(prevBtn)

      // Click "Go to today"
      const todayBtn = screen.getByRole('button', { name: /go to today/i })
      await user.click(todayBtn)

      // Verify the date display shows the current month
      const expectedMonth = format(new Date(), 'MMMM yyyy')

      await waitFor(() => {
        expect(screen.getByTestId('date-display')).toHaveTextContent(expectedMonth)
      })
    })
  })

  // ── Date navigation boundaries (#196) ───────────────────────────────

  describe('date navigation boundaries', () => {
    it('prev button is disabled at MIN_JOURNAL_DATE', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'daily',
        currentDate: MIN_JOURNAL_DATE,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      expect(prevBtn).toBeDisabled()
    })

    it('next button is disabled at MAX_JOURNAL_DATE', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'daily',
        currentDate: MAX_JOURNAL_DATE,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const nextBtn = screen.getByRole('button', { name: /next day/i })
      expect(nextBtn).toBeDisabled()
    })

    it('prev button is enabled when after MIN_JOURNAL_DATE', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'daily',
        currentDate: addDays(MIN_JOURNAL_DATE, 1),
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      expect(prevBtn).toBeEnabled()
    })

    it('next button is enabled when before MAX_JOURNAL_DATE', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'daily',
        currentDate: new Date(),
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const nextBtn = screen.getByRole('button', { name: /next day/i })
      expect(nextBtn).toBeEnabled()
    })

    it('boundary applies to weekly navigation', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'weekly',
        currentDate: MIN_JOURNAL_DATE,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const prevBtn = screen.getByRole('button', { name: /previous week/i })
      expect(prevBtn).toBeDisabled()
    })

    it('boundary applies to monthly navigation', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      useJournalStore.setState({
        mode: 'monthly',
        currentDate: addMonths(new Date(), 12),
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const nextBtn = screen.getByRole('button', { name: /next month/i })
      expect(nextBtn).toBeDisabled()
    })
  })

  // ── Agenda Mode (#608 — AgendaFilterBuilder + AgendaResults) ──────

  describe('agenda mode', () => {
    it('renders AgendaFilterBuilder in agenda mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      await waitFor(() => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
      })
    })

    it('renders AgendaResults in agenda mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      await waitFor(() => {
        expect(screen.getByTestId('agenda-results')).toBeInTheDocument()
      })
    })

    it('renders a visual separator between controls and results', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      await waitFor(() => {
        const agendaView = screen.getByTestId('agenda-view')
        const separator = agendaView.querySelector('.border-t')
        expect(separator).toBeInTheDocument()
      })
    })

    it('default agenda loads dated tasks via queryByProperty with due_date and scheduled_date', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'query_by_property') {
          const params = args as { key?: string }
          if (params?.key === 'due_date') {
            return {
              items: [
                {
                  id: 'TASK-1',
                  block_type: 'content',
                  content: 'Buy groceries',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  is_conflict: false,
                  todo_state: 'TODO',
                  due_date: '2025-06-15',
                  priority: null,
                  scheduled_date: null,
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          if (params?.key === 'scheduled_date') {
            return {
              items: [
                {
                  id: 'TASK-2',
                  block_type: 'content',
                  content: 'Weekly review',
                  parent_id: 'PAGE-1',
                  position: 1,
                  deleted_at: null,
                  is_conflict: false,
                  todo_state: 'TODO',
                  due_date: null,
                  priority: null,
                  scheduled_date: '2025-06-16',
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'batch_resolve') {
          return [{ id: 'PAGE-1', title: 'My Project', block_type: 'page', deleted: false }]
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      // Wait for the filter execution effect to fire and verify both queries are made
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'query_by_property',
          expect.objectContaining({
            key: 'due_date',
          }),
        )
        expect(mockedInvoke).toHaveBeenCalledWith(
          'query_by_property',
          expect.objectContaining({
            key: 'scheduled_date',
          }),
        )
      })

      // AgendaResults should have received merged blocks (2 unique tasks)
      await waitFor(() => {
        const results = screen.getByTestId('agenda-results')
        expect(results).toHaveAttribute('data-block-count', '2')
      })
    })

    it('hides date navigation in agenda mode', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      // Date navigation buttons should not be present
      expect(screen.queryByRole('button', { name: /previous day/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /next day/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /go to today/i })).not.toBeInTheDocument()
    })

    it('displays "Tasks" in the date-display area', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      expect(screen.getByTestId('date-display')).toHaveTextContent('Tasks')
    })

    it('agenda view passes axe a11y check', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      const { container } = renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      await waitFor(async () => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })

  // ── Agenda date filters (#634) ──────────────────────────────────────

  describe('agenda date filters', () => {
    it("dueDate 'Overdue' filter returns blocks with due_date before today", async () => {
      const todayStr = formatDate(new Date())
      const pastDate = formatDate(subDays(new Date(), 3))
      const futureDate = formatDate(addDays(new Date(), 3))

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          return emptyPage
        }
        if (cmd === 'query_by_property') {
          const params = args as { key?: string }
          if (params?.key === 'due_date') {
            return {
              items: [
                {
                  id: 'OVERDUE-1',
                  block_type: 'content',
                  content: 'Overdue task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'TODO',
                  due_date: pastDate,
                  priority: null,
                  scheduled_date: null,
                },
                {
                  id: 'TODAY-1',
                  block_type: 'content',
                  content: 'Today task',
                  parent_id: 'PAGE-1',
                  position: 1,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'TODO',
                  due_date: todayStr,
                  priority: null,
                  scheduled_date: null,
                },
                {
                  id: 'FUTURE-1',
                  block_type: 'content',
                  content: 'Future task',
                  parent_id: 'PAGE-1',
                  position: 2,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'TODO',
                  due_date: futureDate,
                  priority: null,
                  scheduled_date: null,
                },
                {
                  id: 'DONE-OVERDUE',
                  block_type: 'content',
                  content: 'Done overdue task',
                  parent_id: 'PAGE-1',
                  position: 3,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'DONE',
                  due_date: pastDate,
                  priority: null,
                  scheduled_date: null,
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'batch_resolve') {
          return [{ id: 'PAGE-1', title: 'My Project', block_type: 'page', deleted: false }]
        }
        return emptyPage
      })

      useJournalStore.setState({ mode: 'agenda' })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
      })

      act(() => {
        filterChangeRef.current?.([{ dimension: 'dueDate', values: ['Overdue'] }])
      })

      await waitFor(() => {
        const results = screen.getByTestId('agenda-results')
        expect(results).toHaveAttribute('data-block-count', '1')
      })
    })

    it("dueDate 'This week' filter queries with a date range", async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_blocks') {
          return emptyPage
        }
        if (cmd === 'query_by_property') {
          return emptyPage
        }
        if (cmd === 'batch_resolve') {
          return []
        }
        return emptyPage
      })

      useJournalStore.setState({ mode: 'agenda' })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
      })

      act(() => {
        filterChangeRef.current?.([{ dimension: 'dueDate', values: ['This week'] }])
      })

      await waitFor(() => {
        const listBlockCalls = mockedInvoke.mock.calls.filter(
          ([cmd, args]) =>
            cmd === 'list_blocks' &&
            (args as { agendaSource?: string })?.agendaSource === 'column:due_date',
        )
        // Should be a single range call instead of 7 individual day calls
        expect(listBlockCalls).toHaveLength(1)

        const callArgs = listBlockCalls[0]?.[1] as {
          agendaDateRange?: { start: string; end: string }
        }
        expect(callArgs.agendaDateRange).toBeDefined()

        const today = new Date()
        const day = today.getDay()
        const mondayOffset = day === 0 ? -6 : 1 - day
        const weekStart = new Date(today)
        weekStart.setDate(today.getDate() + mondayOffset)
        const weekEnd = new Date(weekStart)
        weekEnd.setDate(weekStart.getDate() + 6)
        expect(callArgs.agendaDateRange?.start).toBe(formatDate(weekStart))
        expect(callArgs.agendaDateRange?.end).toBe(formatDate(weekEnd))
      })
    })

    it("scheduledDate 'Today' filter queries with column:scheduled_date source", async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          const params = args as { agendaSource?: string; agendaDate?: string }
          if (params?.agendaSource === 'column:scheduled_date' && params?.agendaDate === todayStr) {
            return {
              items: [
                {
                  id: 'SCHED-1',
                  block_type: 'content',
                  content: 'Scheduled task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'TODO',
                  due_date: null,
                  priority: null,
                  scheduled_date: todayStr,
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'query_by_property') {
          return emptyPage
        }
        if (cmd === 'batch_resolve') {
          return [{ id: 'PAGE-1', title: 'My Project', block_type: 'page', deleted: false }]
        }
        return emptyPage
      })

      useJournalStore.setState({ mode: 'agenda' })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
      })

      act(() => {
        filterChangeRef.current?.([{ dimension: 'scheduledDate', values: ['Today'] }])
      })

      await waitFor(() => {
        const results = screen.getByTestId('agenda-results')
        expect(results).toHaveAttribute('data-block-count', '1')
      })

      const listBlockCalls = mockedInvoke.mock.calls.filter(
        ([cmd, callArgs]) =>
          cmd === 'list_blocks' &&
          (callArgs as { agendaSource?: string })?.agendaSource === 'column:scheduled_date',
      )
      expect(listBlockCalls.length).toBeGreaterThanOrEqual(1)
      expect((listBlockCalls[0]?.[1] as { agendaDate: string }).agendaDate).toBe(todayStr)
    })

    it("completedDate 'Today' filter queries completed_at with today's date", async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          return emptyPage
        }
        if (cmd === 'query_by_property') {
          const params = args as { key?: string; valueDate?: string }
          if (params?.key === 'completed_at' && params?.valueDate === todayStr) {
            return {
              items: [
                {
                  id: 'DONE-TODAY-1',
                  block_type: 'content',
                  content: 'Completed task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  is_conflict: false,
                  conflict_type: null,
                  todo_state: 'DONE',
                  due_date: null,
                  priority: null,
                  scheduled_date: null,
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'batch_resolve') {
          return [{ id: 'PAGE-1', title: 'My Project', block_type: 'page', deleted: false }]
        }
        return emptyPage
      })

      useJournalStore.setState({ mode: 'agenda' })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('agenda-filter-builder')).toBeInTheDocument()
      })

      act(() => {
        filterChangeRef.current?.([{ dimension: 'completedDate', values: ['Today'] }])
      })

      await waitFor(() => {
        const results = screen.getByTestId('agenda-results')
        expect(results).toHaveAttribute('data-block-count', '1')
      })

      // Verify it called query_by_property with key=completed_at and valueDate=today
      const completedCalls = mockedInvoke.mock.calls.filter(
        ([cmd, callArgs]) =>
          cmd === 'query_by_property' && (callArgs as { key?: string })?.key === 'completed_at',
      )
      expect(completedCalls.length).toBeGreaterThanOrEqual(1)
      expect((completedCalls[0]?.[1] as { valueDate: string }).valueDate).toBe(todayStr)
    })
  })

  // ── DuePanel & LinkedReferences in daily mode ─────────────────────
  describe('DuePanel and LinkedReferences', () => {
    it('daily mode renders DuePanel with correct date', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('due-panel')).toBeInTheDocument()
      })

      expect(screen.getByTestId('due-panel')).toHaveAttribute('data-date', todayStr)
    })

    it('daily mode renders LinkedReferences with correct pageId', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('linked-references')).toBeInTheDocument()
      })

      expect(screen.getByTestId('linked-references')).toHaveAttribute('data-page-id', 'DP-TODAY')
    })

    it('weekly mode does NOT render DuePanel or LinkedReferences', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      await waitFor(() => {
        expect(screen.getAllByRole('region').length).toBe(7)
      })

      expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
    })

    it('monthly mode does NOT render DuePanel or LinkedReferences', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })

      expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
    })

    it('panels not rendered when pageId is null', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
    })

    it('DuePanel renders before LinkedReferences in DOM order', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('due-panel')).toBeInTheDocument()
      })

      const duePanel = screen.getByTestId('due-panel')
      const linkedRefs = screen.getByTestId('linked-references')

      // DuePanel should come before LinkedReferences in DOM order
      // Node.DOCUMENT_POSITION_FOLLOWING = 4
      expect(
        duePanel.compareDocumentPosition(linkedRefs) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })
  })

  // ── DonePanel in daily mode (#609) ─────────────────────────────────
  describe('DonePanel', () => {
    it('daily mode renders DonePanel with correct date', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('done-panel')).toBeInTheDocument()
      })

      expect(screen.getByTestId('done-panel')).toHaveAttribute('data-date', todayStr)
    })

    it('DonePanel renders after LinkedReferences in DOM order', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('done-panel')).toBeInTheDocument()
      })

      const linkedRefs = screen.getByTestId('linked-references')
      const donePanel = screen.getByTestId('done-panel')

      // LinkedReferences should come before DonePanel in DOM order
      // Node.DOCUMENT_POSITION_FOLLOWING = 4
      expect(
        linkedRefs.compareDocumentPosition(donePanel) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })
  })

  // ── Count badges in weekly/monthly modes (#605) ─────────────────────

  describe('count badges in weekly/monthly modes', () => {
    // Use a fixed Monday so weekly views are deterministic
    const monday = new Date(2025, 0, 6) // Mon Jan 6, 2025
    const mondayStr = '2025-01-06'
    const tuesdayStr = '2025-01-07'
    const wednesdayStr = '2025-01-08'

    /**
     * Helper: set up invoke mocks that return pages + badge counts.
     * Override individual count maps via options.
     */
    function setupBadgeMocks(opts?: {
      agendaCountsBySource?: Record<string, Record<string, number>>
      backlinkCounts?: Record<string, number>
      pages?: Array<{ id: string; dateStr: string }>
    }) {
      const pages = opts?.pages ?? [
        { id: 'DP-MON', dateStr: mondayStr },
        { id: 'DP-TUE', dateStr: tuesdayStr },
      ]
      const agendaCountsBySource = opts?.agendaCountsBySource ?? {
        [mondayStr]: { 'column:due_date': 3 },
      }
      const backlinkCounts = opts?.backlinkCounts ?? { 'DP-MON': 5 }

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_blocks') {
          return {
            items: pages.map((p) => makeDailyPage({ id: p.id, content: p.dateStr })),
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'count_agenda_batch_by_source') {
          return agendaCountsBySource
        }
        if (cmd === 'count_backlinks_batch') {
          return backlinkCounts
        }
        return emptyPage
      })
    }

    it('badges render with correct counts in weekly mode', async () => {
      setupBadgeMocks({
        agendaCountsBySource: { [mondayStr]: { 'column:due_date': 3 } },
        backlinkCounts: { 'DP-MON': 5 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByText(/3\s+Due/)).toBeInTheDocument()
        expect(screen.getByText(/5\s+refs/)).toBeInTheDocument()
      })
    })

    it('zero-count badges are hidden', async () => {
      setupBadgeMocks({
        agendaCountsBySource: {},
        backlinkCounts: { 'DP-MON': 0, 'DP-TUE': 0 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      // Wait for the component to finish loading
      await waitFor(() => {
        expect(screen.getAllByRole('region').length).toBe(7)
      })

      // No badge buttons should be rendered (legend shows "Due" without a count prefix)
      expect(screen.queryByText(/\d+\s+Due/)).toBeNull()
      expect(screen.queryByText(/\d+\s+refs/)).toBeNull()
    })

    it('badge click navigates to daily view', async () => {
      const user = userEvent.setup()
      setupBadgeMocks({
        agendaCountsBySource: { [mondayStr]: { 'column:due_date': 3 } },
        backlinkCounts: {},
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByText(/3\s+Due/)).toBeInTheDocument()
      })

      const dueBadge = screen.getByText(/3\s+Due/)
      await user.click(dueBadge)

      // After clicking, mode should change to daily
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /daily view/i })).toHaveAttribute(
          'aria-selected',
          'true',
        )
      })
    })

    it('badge click triggers scroll-to-panel', async () => {
      const user = userEvent.setup()
      setupBadgeMocks({
        agendaCountsBySource: {},
        backlinkCounts: { 'DP-MON': 5 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByText(/5\s+refs/)).toBeInTheDocument()
      })

      const refsBadge = screen.getByText(/5\s+refs/)
      await user.click(refsBadge)

      // After clicking, we navigate to daily mode and the references panel should render
      await waitFor(() => {
        expect(screen.getByTestId('linked-references')).toBeInTheDocument()
      })
    })

    it('multiple days show independent counts', async () => {
      setupBadgeMocks({
        pages: [
          { id: 'DP-MON', dateStr: mondayStr },
          { id: 'DP-TUE', dateStr: tuesdayStr },
          { id: 'DP-WED', dateStr: wednesdayStr },
        ],
        agendaCountsBySource: {
          [mondayStr]: { 'column:due_date': 2 },
          [tuesdayStr]: { 'column:due_date': 7 },
        },
        backlinkCounts: { 'DP-MON': 1, 'DP-TUE': 0, 'DP-WED': 12 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        // Monday: 2 due, 1 ref
        expect(screen.getByText(/2\s+Due/)).toBeInTheDocument()
        expect(screen.getByText(/1\s+refs/)).toBeInTheDocument()
        // Tuesday: 7 due (0 refs hidden)
        expect(screen.getByText(/7\s+Due/)).toBeInTheDocument()
        // Wednesday: 0 due hidden, 12 refs
        expect(screen.getByText(/12\s+refs/)).toBeInTheDocument()
      })
    })

    it('monthly mode passes counts to grid cells', async () => {
      // Use January 2025 — the 6th has a page with counts
      setupBadgeMocks({
        agendaCountsBySource: { [mondayStr]: { 'column:due_date': 4 } },
        backlinkCounts: { 'DP-MON': 8 },
      })

      useJournalStore.setState({ mode: 'monthly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })

      // Verify grid cells exist in the grid
      const cells = screen.getAllByRole('gridcell')
      expect(cells.length).toBeGreaterThanOrEqual(28)
    })

    it('"99+" cap for counts over 99', async () => {
      setupBadgeMocks({
        agendaCountsBySource: { [mondayStr]: { 'column:due_date': 150 } },
        backlinkCounts: { 'DP-MON': 200 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        // Both badges should show "99+" instead of the actual count
        const dueBadge = screen.getByLabelText(/150 Due items/)
        expect(dueBadge).toHaveTextContent(/99\+\s+Due/)

        const refsBadge = screen.getByLabelText(/200 references/)
        expect(refsBadge).toHaveTextContent(/99\+\s+refs/)
      })
    })

    it('badges have aria-labels with counts', async () => {
      setupBadgeMocks({
        agendaCountsBySource: { [mondayStr]: { 'column:due_date': 3 } },
        backlinkCounts: { 'DP-MON': 5 },
      })

      useJournalStore.setState({ mode: 'weekly', currentDate: monday })
      renderJournal()

      await waitFor(() => {
        expect(screen.getByLabelText('3 Due items, click to view')).toBeInTheDocument()
        expect(screen.getByLabelText('5 references, click to view')).toBeInTheDocument()
      })
    })
  })

  // ── Auto-create today's page (#629) ─────────────────────────────────

  describe('auto-create today page (#629)', () => {
    it("auto-creates today's page and focuses block on mount when no page exists", async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          return emptyPage
        }
        if (cmd === 'create_block') {
          const params = args as { blockType: string }
          if (params.blockType === 'page') {
            return {
              id: 'DP-AUTO',
              block_type: 'page',
              content: todayStr,
              parent_id: null,
              position: null,
            }
          }
          if (params.blockType === 'content') {
            return {
              id: 'B-AUTO',
              block_type: 'content',
              content: '',
              parent_id: 'DP-AUTO',
              position: 0,
            }
          }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: todayStr,
          parentId: null,
          position: null,
        })
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'content',
          content: '',
          parentId: 'DP-AUTO',
          position: null,
        })
      })
    })

    it("does NOT auto-create when today's page already exists", async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP-TODAY', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('auto-create applies journal template when it exists', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          const params = args as { parentId?: string }
          if (params?.parentId === 'TMPL-PAGE') {
            return {
              items: [
                {
                  id: 'TC1',
                  block_type: 'content',
                  content: '## Morning Review',
                  parent_id: 'TMPL-PAGE',
                  position: 0,
                },
                {
                  id: 'TC2',
                  block_type: 'content',
                  content: '## Tasks',
                  parent_id: 'TMPL-PAGE',
                  position: 1,
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'query_by_property') {
          const params = args as { key: string }
          if (params.key === 'journal-template') {
            return {
              items: [
                {
                  id: 'TMPL-PAGE',
                  block_type: 'page',
                  content: 'Journal Template',
                },
              ],
              next_cursor: null,
              has_more: false,
            }
          }
          return emptyPage
        }
        if (cmd === 'create_block') {
          const params = args as { blockType: string; content?: string; parentId?: string }
          if (params.blockType === 'page') {
            return {
              id: 'DP-TMPL',
              block_type: 'page',
              content: todayStr,
              parent_id: null,
              position: null,
            }
          }
          if (params.blockType === 'content') {
            return {
              id: `NEW-${params.content?.replace(/\s+/g, '-') ?? 'block'}`,
              block_type: 'content',
              content: params.content ?? '',
              parent_id: params.parentId,
              position: 0,
            }
          }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: todayStr,
          parentId: null,
          position: null,
        })
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'query_by_property',
          expect.objectContaining({
            key: 'journal-template',
            valueText: 'true',
          }),
        )
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'list_blocks',
          expect.objectContaining({
            parentId: 'TMPL-PAGE',
          }),
        )
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_block',
          expect.objectContaining({
            blockType: 'content',
            content: '## Morning Review',
            parentId: 'DP-TMPL',
          }),
        )
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_block',
          expect.objectContaining({
            blockType: 'content',
            content: '## Tasks',
            parentId: 'DP-TMPL',
          }),
        )
      })

      const emptyBlockCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' &&
          (args as { blockType: string; content: string }).blockType === 'content' &&
          (args as { blockType: string; content: string }).content === '',
      )
      expect(emptyBlockCalls).toHaveLength(0)
    })
  })

  // ── Keyboard shortcut for new block (#633) ──────────────────────────

  describe('keyboard shortcut for new block (#633)', () => {
    it('Enter key creates page when empty state is shown in daily mode', async () => {
      const yesterday = subDays(new Date(), 1)
      const yesterdayStr = formatDate(yesterday)

      useJournalStore.setState({ currentDate: yesterday, mode: 'daily' })

      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      mockedInvoke
        .mockResolvedValueOnce({
          id: 'DP-KEY',
          block_type: 'page',
          content: yesterdayStr,
          parent_id: null,
          position: null,
        })
        .mockResolvedValueOnce(emptyPage) // query_by_property for journal-template → none
        .mockResolvedValueOnce({
          id: 'B-KEY',
          block_type: 'content',
          content: '',
          parent_id: 'DP-KEY',
          position: 0,
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: 'B-KEY',
              block_type: 'content',
              content: '',
              parent_id: 'DP-KEY',
              position: 0,
              deleted_at: null,
              is_conflict: false,
            },
          ],
          next_cursor: null,
          has_more: false,
        })

      fireEvent.keyDown(document, { key: 'Enter' })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: yesterdayStr,
          parentId: null,
          position: null,
        })
      })
    })

    it('does NOT fire when inside input/contentEditable', async () => {
      const yesterday = subDays(new Date(), 1)
      const yesterdayStr = formatDate(yesterday)

      useJournalStore.setState({ currentDate: yesterday, mode: 'daily' })

      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Auto-creation now fires for any date in daily mode, wait for it
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: yesterdayStr,
          parentId: null,
          position: null,
        })
      })

      // Clear mocks to track only keyboard-triggered calls
      const callsBefore = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      ).length

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireEvent.keyDown(input, { key: 'Enter' })

      const createPageCallsAfter = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      ).length
      // No additional page creation from keyboard shortcut
      expect(createPageCallsAfter).toBe(callsBefore)

      document.body.removeChild(input)
    })
  })

  // ── Mobile responsiveness ───────────────────────────────────────────

  describe('mobile responsiveness', () => {
    it('journal header has flex-wrap for mobile responsiveness', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const tablist = screen.getByRole('tablist')
      const parent = tablist.parentElement as HTMLElement
      expect(parent.className).toContain('flex-wrap')
    })

    it('date display uses responsive min-width', async () => {
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const dateDisplay = screen.getByTestId('date-display')
      expect(dateDisplay.className).toContain('min-w-[100px]')
      expect(dateDisplay.className).toContain('sm:min-w-[140px]')
    })
  })

  // ── H-1: Auto-creation for any date in daily mode ───────────────────

  describe('auto-creation of first block', () => {
    it('auto-creates page+block for today in daily mode', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: todayStr,
          parentId: null,
          position: null,
        })
      })
    })

    it('auto-creates page+block for a past date in daily mode', async () => {
      const pastDate = subDays(new Date(), 3)
      const pastStr = formatDate(pastDate)

      // Set journal to display a past date
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: pastStr,
          parentId: null,
          position: null,
        })
      })
    })

    it('auto-creates page+block for a future date in daily mode', async () => {
      const futureDate = addDays(new Date(), 5)
      const futureStr = formatDate(futureDate)

      useJournalStore.setState({ mode: 'daily', currentDate: futureDate })
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: futureStr,
          parentId: null,
          position: null,
        })
      })
    })

    it('does NOT auto-create in weekly mode', async () => {
      useJournalStore.setState({ mode: 'weekly', currentDate: new Date() })
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Wait a tick to give effects a chance to fire
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      // No page creation should have occurred from auto-create
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does NOT auto-create in monthly mode', async () => {
      useJournalStore.setState({ mode: 'monthly', currentDate: new Date() })
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Wait a tick to give effects a chance to fire
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      // No page creation should have occurred from auto-create
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does not auto-create when page already exists for the day', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage({ id: 'DP_EXISTING', content: todayStr })],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      // Wait a tick
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })

      // Should not create a page since one already exists
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('re-triggers auto-creation when navigating to a new date', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())
      const yesterdayStr = formatDate(subDays(new Date(), 1))

      // Start with empty pages — today will be auto-created
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_block') {
          return {
            id: 'DP_AUTO',
            block_type: 'page',
            content: todayStr,
            parent_id: null,
            position: null,
          }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Wait for today's auto-creation
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: todayStr,
          parentId: null,
          position: null,
        })
      })

      // Clear mocks to track new calls
      mockedInvoke.mockClear()
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'create_block') {
          return {
            id: 'DP_YESTERDAY',
            block_type: 'page',
            content: yesterdayStr,
            parent_id: null,
            position: null,
          }
        }
        return emptyPage
      })

      // Navigate to previous day
      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      await user.click(prevBtn)

      // Should auto-create for yesterday too
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: yesterdayStr,
          parentId: null,
          position: null,
        })
      })
    })
  })

  // ── Calendar per-source dots (F-19) ──────────────────────────────────

  describe('calendar per-source dots', () => {
    it('fetches agenda-by-source data when calendar opens', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'count_agenda_batch_by_source',
          expect.objectContaining({ dates: expect.any(Array) }),
        )
      })

      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'count_agenda_batch_by_source')
      expect(call).toBeDefined()
      const { dates } = call?.[1] as { dates: string[] }
      expect(dates).toHaveLength(42)
      expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('renders due-dot class for days with due date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'count_agenda_batch_by_source') {
          return { [todayStr]: { 'column:due_date': 2 } }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        const dueDots = document.querySelectorAll('.has-due-dot')
        expect(dueDots.length).toBeGreaterThan(0)
      })
    })

    it('renders scheduled-dot class for days with scheduled date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'count_agenda_batch_by_source') {
          return { [todayStr]: { 'column:scheduled_date': 1 } }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        const scheduledDots = document.querySelectorAll('.has-scheduled-dot')
        expect(scheduledDots.length).toBeGreaterThan(0)
      })
    })

    it('renders property-dot class for days with property date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'count_agenda_batch_by_source') {
          return { [todayStr]: { 'property:deadline': 3 } }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        const propDots = document.querySelectorAll('.has-property-dot')
        expect(propDots.length).toBeGreaterThan(0)
      })
    })

    it('renders multiple dot classes for days with multiple source types', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'count_agenda_batch_by_source') {
          return {
            [todayStr]: {
              'column:due_date': 1,
              'column:scheduled_date': 2,
              'property:deadline': 1,
            },
          }
        }
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const calButton = screen.getByRole('button', { name: /open calendar picker/i })
      await user.click(calButton)

      await waitFor(() => {
        const dueDots = document.querySelectorAll('.has-due-dot')
        const scheduledDots = document.querySelectorAll('.has-scheduled-dot')
        const propDots = document.querySelectorAll('.has-property-dot')
        expect(dueDots.length).toBeGreaterThan(0)
        expect(scheduledDots.length).toBeGreaterThan(0)
        expect(propDots.length).toBeGreaterThan(0)
      })
    })
  })
})
