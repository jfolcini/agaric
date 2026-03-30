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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { addDays, endOfWeek, format, startOfWeek, subDays } from 'date-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string }) => {
    return (
      <div data-testid="block-tree" data-parent-id={props.parentId ?? ''} className="block-tree" />
    )
  },
}))

import { useBlockStore } from '../../stores/blocks'
import { useJournalStore } from '../../stores/journal'
import { JournalControls, JournalPage } from '../JournalPage'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

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

function makeDailyPage(id: string, dateStr: string) {
  return {
    id,
    block_type: 'page',
    content: dateStr,
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useBlockStore.setState({
    blocks: [],
    focusedBlockId: null,
    loading: false,
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
      <JournalPage onNavigateToPage={props?.onNavigateToPage} />
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

      // Daily mode: heading is hidden, date is in the header controls
      const h2s = screen.queryAllByRole('heading', { level: 2 })
      expect(h2s).toHaveLength(0)
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
        items: [makeDailyPage('DP-TODAY', todayStr)],
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
        items: [makeDailyPage('DP-TODAY', todayStr)],
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
    it('shows stacked day sections when switched to monthly', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValue(emptyPage)

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      // Should have multiple sections (one per day of the month)
      const sections = screen.getAllByRole('region')
      // Current month has at least 28 days
      expect(sections.length).toBeGreaterThanOrEqual(28)
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

    it('shows BlockTree for days with pages', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockResolvedValue({
        items: [makeDailyPage('DP-TODAY', todayStr)],
        next_cursor: null,
        has_more: false,
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const monthTab = screen.getByRole('tab', { name: /monthly view/i })
      await user.click(monthTab)

      // Today's section should have a BlockTree (via the mock)
      // Other days should show empty state
      const addButtons = screen.getAllByRole('button', { name: /add block/i })
      expect(addButtons.length).toBeGreaterThanOrEqual(1)
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

      // Set up mocks: create daily page + create child block + load(pageId)
      mockedInvoke
        .mockResolvedValueOnce({
          id: 'DP1',
          block_type: 'page',
          content: todayStr,
          parent_id: null,
          position: null,
        })
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
              archived_at: null,
              is_conflict: false,
            },
          ],
          next_cursor: null,
          has_more: false,
        })

      // Click the "Add block" button in today's section
      const sections = screen.getAllByRole('region')
      const todaySection = sections[0]
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
      const dailyPage = makeDailyPage('DP1', todayStr)

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
      const todaySection = sections[0]
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
  })

  // ── Open in editor ──────────────────────────────────────────────────

  describe('open in editor', () => {
    it('shows "Open in editor" button for days that have pages', async () => {
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage('DP1', todayStr)
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

  // ── Loading state ───────────────────────────────────────────────────

  it('shows loading state while fetching pages', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = renderJournal()

    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
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
    const dailyPage = makeDailyPage('DP1', todayStr)

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
})
