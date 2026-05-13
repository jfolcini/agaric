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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// ── Mock SpaceManageDialog (UX-371) ─────────────────────────────────
// Render a sentinel only when `open === true` so the new
// configure-template entry can be exercised without pulling the dialog's
// internals into this suite.
vi.mock('../SpaceManageDialog', () => ({
  SpaceManageDialog: ({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div role="dialog" aria-label="Manage spaces" data-testid="space-manage-mock" /> : null,
}))

// ── Mock MonthlyDayCell (UX-83) ─────────────────────────────────────
vi.mock('../journal/MonthlyDayCell', () => ({
  MonthlyDayCell: (props: Record<string, unknown>) => {
    const entry = props['entry'] as { dateStr: string; displayDate: string }
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: test mock
      // biome-ignore lint/a11y/useSemanticElements: test mock for gridcell
      // biome-ignore lint/a11y/useKeyWithClickEvents: test mock
      <div
        role="gridcell"
        data-testid={`monthly-cell-${entry.dateStr}`}
        data-is-today={String(!!props['isToday'])}
        data-is-current-month={String(!!props['isCurrentMonth'])}
        data-agenda-count={String(props['agendaCount'])}
        data-backlink-count={String(props['backlinkCount'])}
        aria-label={entry.displayDate}
        onClick={() => (props['onNavigateToDate'] as (d: string) => void)?.(entry.dateStr)}
      >
        {new Date(`${entry.dateStr}T12:00:00`).getDate()}
      </div>
    )
  },
}))

import { __resetCalendarPageDatesForTests } from '../../hooks/useCalendarPageDates'
import { useBlockStore } from '../../stores/blocks'
import { useJournalStore } from '../../stores/journal'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import {
  GlobalDateControls,
  JournalControls,
  JournalPage,
  MAX_JOURNAL_DATE,
  MIN_JOURNAL_DATE,
} from '../JournalPage'

const mockedInvoke = vi.mocked(invoke)

/** Format a Date as YYYY-MM-DD (mirrors the component's formatDate). */
function formatDate(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Format a Date as display string (mirrors the component's formatDateDisplay). */
function formatDateDisplay(d: Date): string {
  return d.toLocaleDateString(undefined, {
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

/**
 * BUG-48: return the canonical empty shape for the new journal commands
 * (`get_journal_page_by_date` → `null`, `list_journal_pages_in_range` →
 * `[]`). Returns the sentinel `BUG48_NOT_HANDLED` for anything else so
 * callers can fall through to their own dispatch logic.
 */
const BUG48_NOT_HANDLED = Symbol('bug48-not-handled')
function bug48EmptyResponse(cmd: string): unknown {
  if (cmd === 'get_journal_page_by_date') return null
  if (cmd === 'list_journal_pages_in_range') return []
  return BUG48_NOT_HANDLED
}

/**
 * BUG-48: install a smart default mock that returns the right empty
 * shapes for the new journal commands and `emptyPage` for every other
 * command. Replaces the previous `mockedInvoke.mockResolvedValue(emptyPage)`
 * one-liner — that pattern still works for legacy paginated commands
 * but breaks the BUG-48 commands which expect non-envelope shapes.
 */
function mockEmptyResponses(): void {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    const bug48 = bug48EmptyResponse(cmd)
    if (bug48 !== BUG48_NOT_HANDLED) return bug48
    return emptyPage
  })
}

/**
 * BUG-48: install a default mock that exposes `pages` to both
 * `list_journal_pages_in_range` (the calendar map fetch) and
 * `get_journal_page_by_date` (the auto-create probe). Other commands
 * fall through to `emptyPage`. Use in tests that previously primed the
 * page list with `mockedInvoke.mockResolvedValue({ items: [...], ... })`.
 */
function mockJournalPages(pages: Array<{ id: string; content: string | null }>): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'list_journal_pages_in_range') return pages
    if (cmd === 'get_journal_page_by_date') {
      const date = (args as { date?: string } | undefined)?.date
      return pages.find((p) => p.content === date) ?? null
    }
    return emptyPage
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetCalendarPageDatesForTests()
  filterChangeRef.current = null
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
  // Reset journal store to defaults — FEAT-3p5 adds per-space slices
  // that we also reset so each test starts from a clean state.
  useJournalStore.setState({
    mode: 'daily',
    currentDate: new Date(),
    currentDateBySpace: {},
    modeBySpace: {},
    scrollToDate: null,
    scrollToPanel: null,
  })
  // BUG-1 / H-3b — JournalPage now routes page creation through
  // `createPageInSpace`, which reads `useSpaceStore.getState().currentSpaceId`.
  // Seed the store so the addBlock path doesn't bail with "No active space".
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
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

// ── Journal-template mock helpers ───────────────────────────────────
// Extracted to keep the caller's mockImplementation under the cognitive
// complexity limit. Each helper models one command's response shape.

/** `list_blocks` response when loading the template page's children. */
function templateListBlocksResponse(args: unknown): unknown {
  const params = args as { parentId?: string } | undefined
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

/**
 * `load_page_subtree` response used by `insertTemplateBlocks` after
 * limit-clamp-followup.  Returns every active descendant of `TMPL-PAGE`
 * as a flat `BlockRow[]` (the root is excluded by contract — see
 * `tauri.ts:loadPageSubtree`).
 */
function templateLoadPageSubtreeResponse(args: unknown): unknown {
  const params = args as { rootBlockId?: string } | undefined
  if (params?.rootBlockId === 'TMPL-PAGE') {
    return [
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
    ]
  }
  return []
}

/** `query_by_property` response that advertises the journal template page. */
function templateQueryByPropertyResponse(args: unknown): unknown {
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

/** `create_block` response for non-page blocks created under the daily page. */
function templateCreateBlockResponse(args: unknown, todayStr: string): unknown {
  const params = args as { blockType: string; content?: string; parentId?: string }
  if (params.blockType === 'page') {
    // Legacy path retained for the helper unit tests below; the
    // production callsite now routes pages through
    // `create_page_in_space`.
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
  return emptyPage
}

/**
 * PEND-35 Tier 4.3: `create_blocks_batch` response. Returns one
 * BlockRow per spec, mirroring the per-spec creation that the legacy
 * per-line `create_block` loop produced. Test code can find the spec
 * for a given content string via the same `mockedInvoke.mock.calls`
 * filter pattern, just looking inside `args.specs[*]` instead of the
 * top-level args.
 */
function templateCreateBlocksBatchResponse(args: unknown): unknown {
  const params = args as
    | { specs?: Array<{ blockType: string; content?: string; parentId?: string }> }
    | undefined
  const specs = params?.specs ?? []
  return specs.map((s) => ({
    id: `NEW-${s.content?.replace(/\s+/g, '-') ?? 'block'}`,
    block_type: s.blockType,
    content: s.content ?? '',
    parent_id: s.parentId,
    position: 0,
  }))
}

/** Dispatcher used by the `auto-create applies journal template` test. */
function makeJournalTemplateMockImpl(todayStr: string) {
  return async (cmd: string, args?: unknown): Promise<unknown> => {
    const bug48 = bug48EmptyResponse(cmd)
    if (bug48 !== BUG48_NOT_HANDLED) return bug48
    if (cmd === 'list_blocks') return templateListBlocksResponse(args)
    if (cmd === 'load_page_subtree') return templateLoadPageSubtreeResponse(args)
    if (cmd === 'query_by_property') return templateQueryByPropertyResponse(args)
    // BUG-1 / H-3b — JournalPage now routes page creation through
    // `create_page_in_space`. The IPC returns the new page ULID as a
    // plain string (see backend `create_page_in_space` Tauri command).
    if (cmd === 'create_page_in_space') return 'DP-TMPL'
    // PEND-35 Tier 4.3 — `insertTemplateBlocks` issues one
    // `create_blocks_batch` IPC per depth level instead of N
    // `create_block` calls.
    if (cmd === 'create_blocks_batch') return templateCreateBlocksBatchResponse(args)
    if (cmd === 'create_block') return templateCreateBlockResponse(args, todayStr)
    return emptyPage
  }
}

describe('JournalPage', () => {
  // ── Daily Mode (default) ────────────────────────────────────────────

  describe('daily mode', () => {
    it('defaults to daily mode showing one day section (today)', async () => {
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Should show exactly 1 day section (today)
      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      expect(sections).toHaveLength(1)

      const todayDisplay = formatDateDisplay(new Date())
      expect(sections[0]).toHaveAccessibleName(`Journal for ${todayDisplay}`)
    })

    it('daily mode hides date heading (shown in header bar instead)', async () => {
      mockEmptyResponses()

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
      mockEmptyResponses()

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

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      expect(sections).toHaveLength(7)
    })

    it('week starts on Monday and ends on Sunday', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 })
      const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 })

      const firstDayDisplay = formatDateDisplay(weekStart)
      const lastDayDisplay = formatDateDisplay(weekEnd)

      expect(sections[0]).toHaveAccessibleName(`Journal for ${firstDayDisplay}`)
      expect(sections[6]).toHaveAccessibleName(`Journal for ${lastDayDisplay}`)
    })

    it('displays week range in nav header', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

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

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      expect(screen.getByRole('tab', { name: /daily view/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /weekly view/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /monthly view/i })).toBeInTheDocument()
    })

    it('Day tab is selected by default', async () => {
      mockEmptyResponses()

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
      mockEmptyResponses()

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

  // ── MAINT-119: page-list fetch dedupe ────────────────────────────────

  describe('page-list fetch dedupe (MAINT-119)', () => {
    it('issues exactly ONE list_journal_pages_in_range fetch when JournalPage + JournalControls mount together', async () => {
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // BUG-48: the page-list fetch is now `list_journal_pages_in_range`
      // (a single un-paginated call) instead of the cursor-paginated
      // `list_blocks` loop.
      const pageFetchCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_journal_pages_in_range',
      )
      // Pre-MAINT-119 this was 2 (one in JournalPage, one in JournalControls).
      // After consolidation it must be exactly 1.
      expect(pageFetchCalls).toHaveLength(1)
    })
  })

  // ── Header bar layout ────────────────────────────────────────────────

  describe('header bar layout', () => {
    it('journal header renders as a flex container (positioned in the fixed header bar)', async () => {
      mockEmptyResponses()

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
    it('creates daily page when no page exists for the day', async () => {
      // PEND-16 — when the user clicks "Add block" on a day with no page
      // yet, `useJournalBlockCreation.handleAddBlock` creates the page
      // but no longer creates the seed block itself in the no-template
      // case. `BlockTree.autoCreateFirstBlock` owns that. BlockTree is
      // mocked in this file, so we only verify the page-create IPC here;
      // the integration test in `JournalPage.integration.test.tsx`
      // exercises the BlockTree side end-to-end.
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // BUG-1 / H-3b — page creation routes through `create_page_in_space`
      // (returns the new page ULID as a plain string), not `create_block`.
      // Use a command-dispatched implementation so the responses are
      // deterministic regardless of call order.
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'create_page_in_space') return 'DP1'
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'create_block') {
          // Defensive: if a regression re-introduces the no-template
          // fallback inside `handleAddBlock`, the mock still returns a
          // sane row so the test fails on the assertion below rather
          // than on a `params.find is not a function` cascade.
          const params = args as { blockType: string; content?: string; parentId?: string }
          return {
            id: 'B1',
            block_type: params.blockType,
            content: params.content ?? '',
            parent_id: params.parentId ?? null,
            position: 0,
          }
        }
        if (cmd === 'list_blocks') {
          return {
            items: [
              {
                id: 'B1',
                block_type: 'text',
                content: '',
                parent_id: 'DP1',
                position: 0,
                deleted_at: null,
              },
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        return emptyPage
      })

      // Click the "Add block" button in today's section
      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
        })
      })
      // PEND-16 — `handleAddBlock` no longer issues a `create_block` IPC
      // for the fresh page. `BlockTree.autoCreateFirstBlock` is the
      // single owner of seed-block creation; it's mocked out here, so we
      // assert the absence of the IPC instead.
      const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
      expect(createBlockCalls).toHaveLength(0)
    })

    it('creates block under existing page without creating new page', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })

      mockJournalPages([dailyPage])

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

      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'content',
          content: '',
          parentId: 'DP1',
          position: null,
          scope: { kind: 'global' },
        })
      })

      // BUG-1 / H-3b — page creation now routes through `create_page_in_space`,
      // so a `create_block({blockType:'page'})` call is impossible
      // by construction. Verify no `create_page_in_space` call fired
      // (the page already existed).
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('focuses the new block after add-block in journal view', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })

      mockJournalPages([dailyPage])

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      // Use a command-dispatched implementation instead of a chained
      // mockResolvedValueOnce queue: under full-suite parallel load,
      // background mount-time invokes can race with the Once queue and
      // consume the planned responses out of order, leaving `block.id`
      // undefined (TEST-3 flake). Dispatching by command name makes the
      // click-time responses deterministic regardless of call order.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'create_block') {
          return {
            id: 'NEW_BLOCK',
            block_type: 'content',
            content: '',
            parent_id: 'DP1',
            position: 1,
          }
        }
        if (cmd === 'list_blocks') {
          return { items: [], next_cursor: null, has_more: false }
        }
        return { items: [], next_cursor: null, has_more: false }
      })

      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      const todaySection = sections[0] as HTMLElement
      const addBtn = within(todaySection).getByRole('button', { name: /add.*block/i })
      await user.click(addBtn)

      // Under full-suite parallel load, the post-mutation focus update is
      // scheduled as a React 19 microtask and the default 1s waitFor
      // timeout can expire before the store reflects the new focused
      // block (TEST-3 flake). 3s waitFor fits well below the 10s
      // test-level timeout.
      await waitFor(
        () => {
          expect(useBlockStore.getState().focusedBlockId).toBe('NEW_BLOCK')
        },
        { timeout: 3000 },
      )
    }, 10000)
  })

  // ── Open in editor ──────────────────────────────────────────────────

  describe('open in editor', () => {
    it('shows "Open in editor" button for days that have pages', async () => {
      const todayStr = formatDate(new Date())
      const dailyPage = makeDailyPage({ id: 'DP1', content: todayStr })
      const onNavigateToPage = vi.fn()

      mockJournalPages([dailyPage])

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
      mockEmptyResponses()

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
      mockEmptyResponses()
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
      mockEmptyResponses()
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
      mockEmptyResponses()
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
      mockEmptyResponses()
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
      mockEmptyResponses()
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })
      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)
      const sections = screen.getAllByRole('region', { name: /^Journal for / })
      for (const section of sections) {
        expect(section.id).toMatch(/^journal-\d{4}-\d{2}-\d{2}$/)
      }
    })

    it('today section has id matching today date string', async () => {
      mockEmptyResponses()
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
    mockEmptyResponses()

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

    mockJournalPages([dailyPage])

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
      mockEmptyResponses()

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

      // Simulate small viewport. The mock object intentionally lacks
      // `addEventListener` — we only need `height` for the flip-detection
      // logic in JournalCalendarDropdown. Floating-UI's `autoUpdate`
      // iterates `win.visualViewport` and calls `.addEventListener('scroll',
      // …)` on it; if this mock leaks into a later test that mounts a
      // Radix Tooltip/Popover, that test crashes in a `useLayoutEffect`.
      // The global `afterEach` in test-setup.ts cleans this up, but we
      // also restore it here for defence in depth.
      Object.defineProperty(window, 'visualViewport', {
        value: { height: 600, width: 1024 },
        writable: true,
        configurable: true,
      })

      try {
        const calButton = screen.getByRole('button', { name: /open calendar picker/i })
        await user.click(calButton)

        // The calendar dropdown should have 'bottom-full' class (flipped above)
        await waitFor(() => {
          const dropdown = document.querySelector('.absolute.z-50.rounded-md')
          expect(dropdown).not.toBeNull()
          expect(dropdown?.className).toContain('bottom-full')
        })
      } finally {
        // Cleanup — restore prototypes and remove the visualViewport mock.
        Element.prototype.getBoundingClientRect = originalGBCR
        delete (window as { visualViewport?: unknown }).visualViewport
      }
    })

    it('shifts right when calendar overflows left edge on narrow viewport', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

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

      // See the comment in the previous test about why this mock must be
      // cleaned up — it lacks `addEventListener` and would break floating-ui
      // for any subsequent Radix Tooltip/Popover mount.
      Object.defineProperty(window, 'visualViewport', {
        value: { height: 800, width: 300 },
        writable: true,
        configurable: true,
      })

      try {
        const calButton = screen.getByRole('button', { name: /open calendar picker/i })
        await user.click(calButton)

        // The calendar dropdown should have a translateX transform to shift right
        await waitFor(() => {
          const dropdown = document.querySelector('.absolute.z-50.rounded-md') as HTMLElement | null
          expect(dropdown).not.toBeNull()
          expect(dropdown?.style.transform).toBe('translateX(28px)')
        })
      } finally {
        Element.prototype.getBoundingClientRect = originalGBCR
        delete (window as { visualViewport?: unknown }).visualViewport
      }
    })
  })

  // ── Calendar dropdown interactions ───────────────────────────────────

  describe('calendar dropdown interactions', () => {
    it('opens calendar when calendar button is clicked', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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
      mockEmptyResponses()

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

    it('default agenda loads TODO+DOING tasks via filteredBlocksQuery with todo_state (UX-196)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'filtered_blocks_query') {
          // Audit H3 — `executeAgendaFilters` now dispatches ONE
          // `filtered_blocks_query` IPC carrying the AND-intersection of
          // every active dimension. The status dimension translates into
          // a single PropertyFilter with `valueTextIn: ['TODO','DOING']`.
          const params = args as {
            propertyFilters?: Array<{ key?: string; valueTextIn?: string[] | null }>
          }
          const statusFilter = params?.propertyFilters?.find((f) => f.key === 'todo_state')
          const valueTextIn = statusFilter?.valueTextIn ?? null
          if (valueTextIn?.includes('TODO') && valueTextIn?.includes('DOING')) {
            return {
              items: [
                {
                  id: 'TASK-1',
                  block_type: 'content',
                  content: 'Buy groceries',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  todo_state: 'TODO',
                  due_date: '2025-06-15',
                  priority: null,
                  scheduled_date: null,
                },
                {
                  id: 'TASK-2',
                  block_type: 'content',
                  content: 'Weekly review',
                  parent_id: 'PAGE-1',
                  position: 1,
                  deleted_at: null,
                  todo_state: 'DOING',
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

      // UX-196: default filter is { status: ['TODO', 'DOING'] }, not empty.
      // Audit H3: active filters dispatch ONE `filtered_blocks_query`
      // carrying the AND-intersected PropertyFilters; status rides
      // through as `valueTextIn`.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'filtered_blocks_query',
          expect.objectContaining({
            propertyFilters: expect.arrayContaining([
              expect.objectContaining({
                key: 'todo_state',
                valueTextIn: ['TODO', 'DOING'],
              }),
            ]),
          }),
        )
      })

      // AgendaResults should have received the 2 TODO/DOING tasks.
      await waitFor(() => {
        const results = screen.getByTestId('agenda-results')
        expect(results).toHaveAttribute('data-block-count', '2')
      })
    })

    it('hides prev/next arrows in agenda mode but keeps Today + calendar visible (UX-235)', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const agendaTab = screen.getByRole('tab', { name: /agenda view/i })
      await user.click(agendaTab)

      // Prev/next arrows are hidden (no date context)
      expect(screen.queryByRole('button', { name: /previous day/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /next day/i })).not.toBeInTheDocument()

      // Today button and calendar trigger remain accessible (UX-235)
      expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /open calendar picker/i })).toBeInTheDocument()
    })

    it('displays "Tasks" in the date-display area', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

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
      mockEmptyResponses()

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

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'filtered_blocks_query') {
          // Audit H3 — `executeAgendaFilters` translates the legacy
          // client-side `Overdue` filter into TWO PropertyFilters intersected
          // server-side: `due_date < today` and `todo_state != 'DONE'`.
          // The backend returns only the post-intersection result set.
          const params = args as {
            propertyFilters?: Array<{
              key?: string
              operator?: string
              valueDate?: string | null
              valueText?: string | null
            }>
          }
          const dueDateFilter = params?.propertyFilters?.find((f) => f.key === 'due_date')
          const todoStateFilter = params?.propertyFilters?.find((f) => f.key === 'todo_state')
          if (
            dueDateFilter?.operator === 'lt' &&
            dueDateFilter?.valueDate === todayStr &&
            todoStateFilter?.operator === 'neq' &&
            todoStateFilter?.valueText === 'DONE'
          ) {
            return {
              items: [
                {
                  id: 'OVERDUE-1',
                  block_type: 'content',
                  content: 'Overdue task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
                  todo_state: 'TODO',
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

    it("dueDate 'This week' filter queries with a half-open date range", async () => {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'filtered_blocks_query') {
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
        // Audit H3 — single `filtered_blocks_query` IPC carrying a
        // PropertyFilter with a half-open `valueDateRange` on `due_date`.
        // (AgendaView mounts with a default status filter, so we filter
        //  by the call that carries our test dimension to ignore the
        //  initial-mount status-only IPC.)
        const filteredCalls = mockedInvoke.mock.calls.filter(([cmd, args]) => {
          if (cmd !== 'filtered_blocks_query') return false
          const a = args as {
            propertyFilters?: Array<{ key?: string }>
          }
          return Boolean(a.propertyFilters?.some((f) => f.key === 'due_date'))
        })
        expect(filteredCalls).toHaveLength(1)

        const callArgs = filteredCalls[0]?.[1] as {
          propertyFilters?: Array<{
            key?: string
            valueDateRange?: [string, string] | null
          }>
        }
        const dueDateFilter = callArgs.propertyFilters?.find((f) => f.key === 'due_date')
        expect(dueDateFilter?.valueDateRange).toBeDefined()

        const today = new Date()
        const day = today.getDay()
        const mondayOffset = day === 0 ? -6 : 1 - day
        const weekStart = new Date(today)
        weekStart.setDate(today.getDate() + mondayOffset)
        const weekEnd = new Date(weekStart)
        weekEnd.setDate(weekStart.getDate() + 6)
        // Half-open form: end is the day AFTER weekEnd (= weekStart+7).
        const endExclusive = new Date(weekStart)
        endExclusive.setDate(weekStart.getDate() + 7)
        expect(dueDateFilter?.valueDateRange?.[0]).toBe(formatDate(weekStart))
        expect(dueDateFilter?.valueDateRange?.[1]).toBe(formatDate(endExclusive))
      })
    })

    it("scheduledDate 'Today' filter queries scheduled_date with today's date", async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'filtered_blocks_query') {
          // Audit H3 — `scheduledDate: ['Today']` translates to one
          // PropertyFilter with `key: 'scheduled_date'`, `operator: 'eq'`,
          // `valueDate: today`.
          const params = args as {
            propertyFilters?: Array<{
              key?: string
              operator?: string
              valueDate?: string | null
            }>
          }
          const schedFilter = params?.propertyFilters?.find((f) => f.key === 'scheduled_date')
          if (schedFilter?.operator === 'eq' && schedFilter?.valueDate === todayStr) {
            return {
              items: [
                {
                  id: 'SCHED-1',
                  block_type: 'content',
                  content: 'Scheduled task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
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

      const filteredCalls = mockedInvoke.mock.calls.filter(([cmd, args]) => {
        if (cmd !== 'filtered_blocks_query') return false
        const a = args as { propertyFilters?: Array<{ key?: string }> }
        return Boolean(a.propertyFilters?.some((f) => f.key === 'scheduled_date'))
      })
      expect(filteredCalls.length).toBeGreaterThanOrEqual(1)
      const callArgs = filteredCalls[0]?.[1] as {
        propertyFilters?: Array<{ key?: string; valueDate?: string | null }>
      }
      const schedFilter = callArgs.propertyFilters?.find((f) => f.key === 'scheduled_date')
      expect(schedFilter?.valueDate).toBe(todayStr)
    })

    it("completedDate 'Today' filter queries completed_at with today's date", async () => {
      const todayStr = formatDate(new Date())
      // Audit H3 — `executeAgendaFilters` now routes through
      // `filtered_blocks_query` with `valueDateRange: [today, tomorrow]`
      // (half-open). Compute tomorrow the same way as the module under
      // test so DST / month-rollover stay consistent.
      const tomorrow = new Date(`${todayStr}T00:00:00`)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowStr = formatDate(tomorrow)

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'filtered_blocks_query') {
          const params = args as {
            propertyFilters?: Array<{
              key?: string
              valueDateRange?: [string, string] | null
            }>
          }
          const completedFilter = params?.propertyFilters?.find((f) => f.key === 'completed_at')
          const range = completedFilter?.valueDateRange ?? null
          if (range?.[0] === todayStr) {
            return {
              items: [
                {
                  id: 'DONE-TODAY-1',
                  block_type: 'content',
                  content: 'Completed task',
                  parent_id: 'PAGE-1',
                  position: 0,
                  deleted_at: null,
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

      // Verify the `filtered_blocks_query` IPC for completed_at carries
      // a PropertyFilter with the half-open range. (AgendaView mounts
      // with a default status filter, so we filter to the call that
      // carries the completed_at dimension to ignore the initial-mount
      // status-only IPC.)
      const filteredCalls = mockedInvoke.mock.calls.filter(([cmd, args]) => {
        if (cmd !== 'filtered_blocks_query') return false
        const a = args as { propertyFilters?: Array<{ key?: string }> }
        return Boolean(a.propertyFilters?.some((f) => f.key === 'completed_at'))
      })
      expect(filteredCalls.length).toBe(1)
      const propertyFilters = (
        filteredCalls[0]?.[1] as {
          propertyFilters?: Array<{
            key?: string
            valueDateRange?: [string, string] | null
          }>
        }
      ).propertyFilters
      const completedFilter = propertyFilters?.find((f) => f.key === 'completed_at')
      expect(completedFilter?.valueDateRange).toEqual([todayStr, tomorrowStr])
    })
  })

  // ── DuePanel & LinkedReferences in daily mode ─────────────────────
  describe('DuePanel and LinkedReferences', () => {
    it('daily mode renders DuePanel with correct date', async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('due-panel')).toBeInTheDocument()
      })

      expect(screen.getByTestId('due-panel')).toHaveAttribute('data-date', todayStr)
    })

    it('daily mode renders LinkedReferences with correct pageId', async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('linked-references')).toBeInTheDocument()
      })

      expect(screen.getByTestId('linked-references')).toHaveAttribute('data-page-id', 'DP-TODAY')
    })

    it('weekly mode does NOT render DuePanel or LinkedReferences', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const weekTab = screen.getByRole('tab', { name: /weekly view/i })
      await user.click(weekTab)

      await waitFor(() => {
        expect(screen.getAllByRole('region', { name: /^Journal for / }).length).toBe(7)
      })

      expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
    })

    it('monthly mode does NOT render DuePanel or LinkedReferences', async () => {
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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

    it('LinkedReferences not rendered when pageId is null', async () => {
      // BUG-48 follow-up: DuePanel and DonePanel are date-keyed
      // agenda queries, so they render even when no journal page
      // exists for the day (e.g. navigating to a past date that was
      // never written into). Only LinkedReferences is gated on
      // pageId because backlinks into a non-existent page are
      // semantically empty.
      const todayStr = formatDate(new Date())

      // Today's journal mount-effect would auto-create a page; pin
      // the probe to "page exists" via mockJournalPages but use a
      // currentDate that has no page, so the displayed entry has
      // pageId=null.
      const pastDate = subDays(new Date(), 5)
      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })
      void todayStr // clarity: only the displayed date matters
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // DuePanel + DonePanel still render (date-keyed), only
      // LinkedReferences is suppressed.
      expect(screen.queryByTestId('linked-references')).not.toBeInTheDocument()
    })

    it('DuePanel renders before LinkedReferences in DOM order', async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.getByTestId('done-panel')).toBeInTheDocument()
      })

      expect(screen.getByTestId('done-panel')).toHaveAttribute('data-date', todayStr)
    })

    it('DonePanel renders after LinkedReferences in DOM order', async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

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

      const pageRows = pages.map((p) => makeDailyPage({ id: p.id, content: p.dateStr }))
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        // BUG-48: the calendar fetch + auto-create probe both come
        // from the new journal commands now.
        if (cmd === 'list_journal_pages_in_range') return pageRows
        if (cmd === 'get_journal_page_by_date') {
          const date = (args as { date?: string } | undefined)?.date
          return pageRows.find((p) => p.content === date) ?? null
        }
        if (cmd === 'list_blocks') {
          return {
            items: pageRows,
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
        expect(screen.getAllByRole('region', { name: /^Journal for / }).length).toBe(7)
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
    it("auto-creates today's page on mount when no page exists", async () => {
      // PEND-16 — `useJournalAutoCreate` triggers `handleAddBlock` on
      // mount, which creates the daily page. The seed block is no
      // longer created here; `BlockTree.autoCreateFirstBlock` owns that
      // step. BlockTree is mocked in this file, so we assert just the
      // page-create IPC. The end-to-end "exactly one create_block"
      // contract is covered by `JournalPage.integration.test.tsx`.
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'list_blocks') {
          return emptyPage
        }
        // BUG-1 / H-3b — page creation goes through `create_page_in_space`,
        // returning the new ULID as a string.
        if (cmd === 'create_page_in_space') return 'DP-AUTO'
        if (cmd === 'create_block') {
          // Defensive — see PEND-16 note above. Returning a real row
          // keeps the failure mode "explicit assertion below" rather
          // than a downstream null-deref if a regression re-introduces
          // the no-template fallback in `handleAddBlock`.
          const params = args as { blockType: string }
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
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
        })
      })

      // PEND-16 — `handleAddBlock` no longer issues `create_block` for
      // a fresh page in the no-template case; BlockTree owns that and
      // is mocked here. Flush microtasks so a hypothetical mis-firing
      // call would still be observable in the assertion below.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      const createBlockCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_block')
      expect(createBlockCalls).toHaveLength(0)
    })

    it("does NOT auto-create when today's page already exists", async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP-TODAY', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('auto-create applies journal template when it exists', async () => {
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(makeJournalTemplateMockImpl(todayStr))

      renderJournal()

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
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

      // limit-clamp-followup — `insertTemplateBlocks` now fetches the
      // whole template subtree via `load_page_subtree(rootBlockId)`
      // instead of recursing through `list_blocks(parentId)`.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'load_page_subtree',
          expect.objectContaining({
            rootBlockId: 'TMPL-PAGE',
          }),
        )
      })

      // PEND-35 Tier 4.3 — `insertTemplateBlocks` collapses the per-child
      // `create_block` loop into a single `create_blocks_batch` per
      // depth level. The two top-level template children land in one
      // batch; assert on the `specs` array.
      await waitFor(() => {
        const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
        expect(batchCalls.length).toBeGreaterThan(0)
      })
      const batchCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'create_blocks_batch')
      const batchSpecs = (batchCall?.[1] as { specs: Array<Record<string, unknown>> }).specs
      const morningReview = batchSpecs.find((s) => s['content'] === '## Morning Review')
      const tasks = batchSpecs.find((s) => s['content'] === '## Tasks')
      expect(morningReview).toMatchObject({ blockType: 'content', parentId: 'DP-TMPL' })
      expect(tasks).toMatchObject({ blockType: 'content', parentId: 'DP-TMPL' })

      // No empty-content content specs should appear (regression guard
      // for the legacy "extra blank seed block" bug).
      const emptyBlockSpecs = mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === 'create_blocks_batch')
        .flatMap(
          ([, args]) => (args as { specs: Array<{ blockType: string; content: string }> }).specs,
        )
        .filter((s) => s.blockType === 'content' && s.content === '')
      expect(emptyBlockSpecs).toHaveLength(0)
    })
  })

  // ── Per-space journal template (FEAT-3p5b) ──────────────────────────

  describe('per-space journal template (FEAT-3p5b)', () => {
    /**
     * Build an IPC dispatcher modelling: per-space `journal_template`
     * property + optional legacy `journal-template` page. Both
     * surfaces hit the same `create_page_in_space` and `create_block`
     * mocks so the assertion can pin down which template ran by
     * inspecting the resulting `create_block` call sequence.
     */
    function makePerSpaceMock(opts: {
      perSpaceTemplate: string | null
      legacyTemplatePage: boolean
    }) {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-space template test mock fans out across 7 distinct Tauri commands (list_blocks / get_properties / get_block_property_def / list_blocks_lite / list_pages / create_block / create_page_in_space) to pin the FEAT-3p5b template-seeding flow; flattening into one switch keeps the cause-effect chain in one place. Score 32 vs default 25.
      return async (cmd: string, args?: unknown): Promise<unknown> => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'list_blocks') return templateListBlocksResponse(args)
        if (cmd === 'load_page_subtree') return templateLoadPageSubtreeResponse(args)
        if (cmd === 'get_property') {
          // PEND-35 Tier 2.4c: single-key PK lookup. Returns PropertyRow | null.
          const a = (args as { blockId: string; key: string } | undefined) ?? {
            blockId: '',
            key: '',
          }
          if (a.key !== 'journal_template' || opts.perSpaceTemplate == null) return null
          return {
            key: 'journal_template',
            value_text: opts.perSpaceTemplate,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
          }
        }
        if (cmd === 'query_by_property') {
          if (opts.legacyTemplatePage) return templateQueryByPropertyResponse(args)
          return emptyPage
        }
        if (cmd === 'create_page_in_space') return 'DP-PS'
        if (cmd === 'create_blocks_batch') {
          // PEND-35 Tier 4.3 — `insertTemplateBlocksFromString`
          // (per-space) and `insertTemplateBlocks` (legacy page) both
          // call this batch IPC. Return one BlockRow per spec.
          return templateCreateBlocksBatchResponse(args)
        }
        if (cmd === 'create_block') {
          const params = args as { blockType: string; content?: string; parentId?: string }
          return {
            id: `NEW-${params.content?.replace(/\s+/g, '-') ?? 'block'}`,
            block_type: params.blockType,
            content: params.content ?? '',
            parent_id: params.parentId,
            position: 0,
          }
        }
        return emptyPage
      }
    }

    it('per-space journal template applies on new daily page creation', async () => {
      mockedInvoke.mockImplementation(
        makePerSpaceMock({
          perSpaceTemplate: 'Morning standup\nTODOs',
          legacyTemplatePage: false,
        }),
      )

      renderJournal()

      // Page is created via `create_page_in_space` for today.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'create_page_in_space',
          expect.objectContaining({ spaceId: 'SPACE_TEST' }),
        )
      })

      // Per-space property lookup hits get_property with the space id + key.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('get_property', {
          blockId: 'SPACE_TEST',
          key: 'journal_template',
        })
      })

      // PEND-35 Tier 4.3 — `insertTemplateBlocksFromString` collapses
      // the per-line `create_block` loop into a single
      // `create_blocks_batch` IPC. Both lines must land in one batch's
      // `specs` array.
      await waitFor(() => {
        const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
        expect(batchCalls.length).toBeGreaterThan(0)
      })
      const batchSpecs = mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === 'create_blocks_batch')
        .flatMap(([, args]) => (args as { specs: Array<Record<string, unknown>> }).specs)
      expect(batchSpecs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            blockType: 'content',
            content: 'Morning standup',
            parentId: 'DP-PS',
          }),
          expect.objectContaining({
            blockType: 'content',
            content: 'TODOs',
            parentId: 'DP-PS',
          }),
        ]),
      )
    })

    it('per-space journal template takes precedence over legacy global journal-template', async () => {
      mockedInvoke.mockImplementation(
        makePerSpaceMock({
          perSpaceTemplate: 'Morning standup\nTODOs',
          legacyTemplatePage: true,
        }),
      )

      renderJournal()

      // PEND-35 Tier 4.3 — both surfaces use `create_blocks_batch`.
      // The per-space content blocks must land in some batch's specs.
      await waitFor(() => {
        const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
        expect(batchCalls.length).toBeGreaterThan(0)
      })
      const allBatchSpecs = mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === 'create_blocks_batch')
        .flatMap(([, args]) => (args as { specs: Array<Record<string, unknown>> }).specs)
      expect(allBatchSpecs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'Morning standup' }),
          expect.objectContaining({ content: 'TODOs' }),
        ]),
      )

      // ...and the legacy template's children (`## Morning Review`,
      // `## Tasks`) must NOT have been copied. Ensures the
      // pre-existing legacy `insertTemplateBlocks` path was skipped.
      const legacyContentSpecs = allBatchSpecs.filter(
        (s) => s['content'] === '## Morning Review' || s['content'] === '## Tasks',
      )
      expect(legacyContentSpecs).toHaveLength(0)
    })

    it('falls back to legacy journal-template when per-space property absent', async () => {
      mockedInvoke.mockImplementation(
        makePerSpaceMock({ perSpaceTemplate: null, legacyTemplatePage: true }),
      )

      renderJournal()

      // Legacy path: query_by_property('journal-template') is hit AND
      // its child blocks (`## Morning Review`, `## Tasks`) are copied
      // via PEND-35 Tier 4.3's `create_blocks_batch`.
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
        const batchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_blocks_batch')
        expect(batchCalls.length).toBeGreaterThan(0)
      })
      const legacyBatchSpecs = mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === 'create_blocks_batch')
        .flatMap(([, args]) => (args as { specs: Array<Record<string, unknown>> }).specs)
      expect(legacyBatchSpecs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ blockType: 'content', content: '## Morning Review' }),
          expect.objectContaining({ blockType: 'content', content: '## Tasks' }),
        ]),
      )
    })
  })

  // ── Keyboard shortcut for new block (#633) ──────────────────────────

  describe('keyboard shortcut for new block (#633)', () => {
    it('Enter key creates page when empty state is shown in daily mode', async () => {
      const yesterday = subDays(new Date(), 1)
      const yesterdayStr = formatDate(yesterday)

      useJournalStore.setState({ currentDate: yesterday, mode: 'daily' })

      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // BUG-1 / H-3b — page creation routes through `create_page_in_space`.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'create_page_in_space') return 'DP-KEY'
        if (cmd === 'query_by_property') return emptyPage
        if (cmd === 'create_block') {
          return {
            id: 'B-KEY',
            block_type: 'content',
            content: '',
            parent_id: 'DP-KEY',
            position: 0,
          }
        }
        if (cmd === 'list_blocks') return emptyPage
        return emptyPage
      })

      fireEvent.keyDown(document, { key: 'Enter' })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: yesterdayStr,
          spaceId: 'SPACE_TEST',
        })
      })
    })

    it('does NOT fire when inside input/contentEditable', async () => {
      const todayStr = formatDate(new Date())

      useJournalStore.setState({ currentDate: new Date(), mode: 'daily' })

      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Today's mount-effect auto-creates the page; wait for it to settle
      // before asserting the keyboard branch is suppressed inside an input.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
        })
      })

      // Clear mocks to track only keyboard-triggered calls
      const callsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      ).length

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireEvent.keyDown(input, { key: 'Enter' })

      const createPageCallsAfter = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      ).length
      // No additional page creation from keyboard shortcut
      expect(createPageCallsAfter).toBe(callsBefore)

      document.body.removeChild(input)
    })
  })

  // ── Mobile responsiveness ───────────────────────────────────────────

  describe('mobile responsiveness', () => {
    it('journal header stacks vertically on mobile via flex-col sm:flex-row', async () => {
      // PEND journal-header-responsive: the previous shape relied on
      // `flex-wrap` to keep controls reachable on narrow screens, but the
      // 56 px header height clipped anything that wrapped past the first
      // row. The new shape stacks the mode tabs and the date-nav row on
      // their own rows under sm:, and inlines them at sm:+.
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const tablist = screen.getByRole('tablist')
      const parent = tablist.parentElement as HTMLElement
      expect(parent.className).toContain('flex-col')
      expect(parent.className).toContain('sm:flex-row')
    })

    // PEND-28 M11: the previous shape (`min-w-[100px] sm:min-w-[140px]`)
    // reserved 100 px (~28 % of a 360 px viewport) on phones for the date
    // readout. The min-width is now gated on `sm:` so phones let the date
    // determine its own width, while sm+ still gets a 100 px floor.
    it('date display min-width is scoped to sm: breakpoint', async () => {
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      const dateDisplay = screen.getByTestId('date-display')
      expect(dateDisplay.className).toContain('sm:min-w-[100px]')
      // No unguarded `min-w-[100px]` reservation on phones.
      expect(dateDisplay.className).not.toMatch(/(?:^|\s)min-w-\[100px\]/)
    })
  })

  // ── H-1: Auto-creation for any date in daily mode ───────────────────

  describe('auto-creation of first block', () => {
    // BUG-1 / H-3b — page creation routes through `create_page_in_space`.
    // All tests in this group assert the new IPC name + payload shape.
    it('auto-creates page+block for today in daily mode', async () => {
      const todayStr = formatDate(new Date())

      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
        })
      })
    })

    it('does NOT auto-create on mount for a past date in daily mode', async () => {
      // BUG-48 follow-up: the mount-effect is restricted to today so the
      // calendar can't silently spawn empty journal pages for any day the
      // user merely navigates to. Past dates require an explicit
      // `n`/`Enter` shortcut or the Add block button to backfill.
      const pastDate = subDays(new Date(), 3)

      useJournalStore.setState({ mode: 'daily', currentDate: pastDate })
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does NOT auto-create on mount for a future date in daily mode', async () => {
      // BUG-48 follow-up: same rationale as the past-date test — only
      // today's page is conjured for free; the user opts in for any
      // other day.
      const futureDate = addDays(new Date(), 5)

      useJournalStore.setState({ mode: 'daily', currentDate: futureDate })
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does NOT auto-create in weekly mode', async () => {
      useJournalStore.setState({ mode: 'weekly', currentDate: new Date() })
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Auto-create runs synchronously in the post-render effect; flush
      // one macrotask boundary via the canonical act-wrapped microtask
      // flush so a hypothetical mis-firing call would be visible.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      // No page creation should have occurred from auto-create
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does NOT auto-create in monthly mode', async () => {
      useJournalStore.setState({ mode: 'monthly', currentDate: new Date() })
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Auto-create runs synchronously in the post-render effect; flush
      // one macrotask boundary via the canonical act-wrapped microtask
      // flush so a hypothetical mis-firing call would be visible.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      // No page creation should have occurred from auto-create
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does not auto-create when page already exists for the day', async () => {
      const todayStr = formatDate(new Date())

      mockJournalPages([makeDailyPage({ id: 'DP_EXISTING', content: todayStr })])

      renderJournal()

      await waitFor(() => {
        expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      })

      // Flush one macrotask boundary via the canonical act-wrapped
      // microtask flush so a hypothetical mis-firing call would be visible.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      // Should not create a page since one already exists
      const createPageCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      )
      expect(createPageCalls).toHaveLength(0)
    })

    it('does NOT re-trigger auto-creation when navigating to a different date', async () => {
      // BUG-48 follow-up: navigating off today no longer eagerly spawns
      // pages. Today's auto-create still fires on mount; clicking
      // previous-day must not result in a fresh `create_page_in_space`
      // for yesterday.
      const user = userEvent.setup()
      const todayStr = formatDate(new Date())

      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
        if (cmd === 'create_page_in_space') return 'DP_AUTO'
        return emptyPage
      })

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Wait for today's auto-creation
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: todayStr,
          spaceId: 'SPACE_TEST',
        })
      })

      const callsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      ).length

      // Navigate to previous day
      const prevBtn = screen.getByRole('button', { name: /previous day/i })
      await user.click(prevBtn)

      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      const callsAfter = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'create_page_in_space',
      ).length
      expect(callsAfter).toBe(callsBefore)
    })
  })

  // ── Calendar per-source dots (F-19) ──────────────────────────────────

  describe('calendar per-source dots', () => {
    it('fetches agenda-by-source data when calendar opens', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

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

    it('renders due dots for days with due date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
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
        const dueDots = document.querySelectorAll('.bg-date-due-foreground')
        // 1 dot under today's calendar cell + 1 dot in the legend = 2
        expect(dueDots).toHaveLength(2)
      })
    })

    it('renders scheduled dots for days with scheduled date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
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
        const scheduledDots = document.querySelectorAll('.bg-date-scheduled-foreground')
        // 1 dot under today's calendar cell + 1 dot in the legend = 2
        expect(scheduledDots).toHaveLength(2)
      })
    })

    it('renders property dots for days with property date items', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
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
        const propDots = document.querySelectorAll('.bg-date-property-foreground')
        // 1 dot under today's calendar cell + 1 dot in the legend = 2
        expect(propDots).toHaveLength(2)
      })
    })

    it('renders multiple dot types for days with multiple source types', async () => {
      const user = userEvent.setup()
      const today = new Date()
      const todayStr = formatDate(today)

      mockedInvoke.mockImplementation(async (cmd: string) => {
        const bug48 = bug48EmptyResponse(cmd)
        if (bug48 !== BUG48_NOT_HANDLED) return bug48
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
        const dueDots = document.querySelectorAll('.bg-date-due-foreground')
        const scheduledDots = document.querySelectorAll('.bg-date-scheduled-foreground')
        const propDots = document.querySelectorAll('.bg-date-property-foreground')
        // Each: 1 dot under today's calendar cell + 1 dot in the legend = 2
        expect(dueDots).toHaveLength(2)
        expect(scheduledDots).toHaveLength(2)
        expect(propDots).toHaveLength(2)
      })
    })
  })

  // ── Smoke tests for journal-template mock helpers ──────────────────

  describe('journal template mock helpers', () => {
    it('templateListBlocksResponse: returns the template children for TMPL-PAGE', () => {
      const result = templateListBlocksResponse({ parentId: 'TMPL-PAGE' }) as {
        items: Array<{ id: string; content: string }>
        has_more: boolean
      }
      expect(result.items).toHaveLength(2)
      expect(result.items[0]?.id).toBe('TC1')
      expect(result.items[0]?.content).toBe('## Morning Review')
      expect(result.items[1]?.id).toBe('TC2')
      expect(result.items[1]?.content).toBe('## Tasks')
      expect(result.has_more).toBe(false)
    })

    it('templateListBlocksResponse: returns emptyPage for any other parentId', () => {
      expect(templateListBlocksResponse({ parentId: 'OTHER-PAGE' })).toBe(emptyPage)
      expect(templateListBlocksResponse(undefined)).toBe(emptyPage)
    })

    it('templateQueryByPropertyResponse: returns the template page for `journal-template` key', () => {
      const result = templateQueryByPropertyResponse({ key: 'journal-template' }) as {
        items: Array<{ id: string; content: string }>
      }
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.id).toBe('TMPL-PAGE')
      expect(result.items[0]?.content).toBe('Journal Template')
    })

    it('templateQueryByPropertyResponse: returns emptyPage for any other key', () => {
      expect(templateQueryByPropertyResponse({ key: 'something-else' })).toBe(emptyPage)
    })

    it('templateCreateBlockResponse: returns a daily page when blockType is `page`', () => {
      const result = templateCreateBlockResponse({ blockType: 'page' }, '2024-01-15') as {
        id: string
        content: string
        parent_id: null
      }
      expect(result.id).toBe('DP-TMPL')
      expect(result.content).toBe('2024-01-15')
      expect(result.parent_id).toBe(null)
    })

    it('templateCreateBlockResponse: returns a derived content block when blockType is `content`', () => {
      const result = templateCreateBlockResponse(
        { blockType: 'content', content: '## Morning Review', parentId: 'DP-TMPL' },
        '2024-01-15',
      ) as { id: string; content: string; parent_id: string }
      expect(result.id).toBe('NEW-##-Morning-Review')
      expect(result.content).toBe('## Morning Review')
      expect(result.parent_id).toBe('DP-TMPL')
    })

    it('templateCreateBlockResponse: falls back to emptyPage for unknown blockType', () => {
      expect(templateCreateBlockResponse({ blockType: 'mystery' }, '2024-01-15')).toBe(emptyPage)
    })

    it('makeJournalTemplateMockImpl: dispatches each supported command', async () => {
      const impl = makeJournalTemplateMockImpl('2024-01-15')
      const listResult = (await impl('list_blocks', { parentId: 'TMPL-PAGE' })) as {
        items: Array<unknown>
      }
      expect(listResult.items).toHaveLength(2)

      const queryResult = (await impl('query_by_property', { key: 'journal-template' })) as {
        items: Array<unknown>
      }
      expect(queryResult.items).toHaveLength(1)

      const pageResult = (await impl('create_block', { blockType: 'page' })) as { id: string }
      expect(pageResult.id).toBe('DP-TMPL')

      // Falls through to emptyPage for unknown commands.
      expect(await impl('something_else')).toBe(emptyPage)
    })
  })

  // ── UX-235: agenda-mode date controls (Today + calendar) ─────────────
  describe('JournalControls agenda-mode date controls (UX-235)', () => {
    // Fixed system time so "today" is deterministic: Mon, April 20, 2026.
    // Only fake `Date` (not timers) so userEvent's internal setTimeouts run
    // normally — faking all timers would deadlock async user.click() here.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-04-20T12:00:00'))
      useJournalStore.setState({ mode: 'agenda', currentDate: new Date('2026-04-20T12:00:00') })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('renders Today button in agenda mode', () => {
      mockEmptyResponses()
      renderJournal()
      expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
    })

    it('renders calendar trigger in agenda mode', () => {
      mockEmptyResponses()
      renderJournal()
      expect(screen.getByRole('button', { name: /open calendar picker/i })).toBeInTheDocument()
    })

    it('hides prev/next arrows and the formatted date display in agenda mode', () => {
      // Set a non-today currentDate so the agenda-mode branch is exercised.
      useJournalStore.setState({ mode: 'agenda', currentDate: new Date('2026-03-15T12:00:00') })
      mockEmptyResponses()
      renderJournal()

      expect(screen.queryByRole('button', { name: /previous day/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /next day/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /previous week/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /previous month/i })).not.toBeInTheDocument()

      // The only element with data-testid="date-display" in agenda mode is the
      // "Tasks" label — the formatted date display span is gated by
      // `mode !== 'agenda'`.
      const dateDisplay = screen.getByTestId('date-display')
      expect(dateDisplay).toHaveTextContent('Tasks')
      expect(dateDisplay).not.toHaveTextContent(/2026|March|Mar/)
    })

    it('keeps the "Tasks" label in agenda mode', () => {
      mockEmptyResponses()
      renderJournal()
      expect(screen.getByTestId('date-display')).toHaveTextContent('Tasks')
    })

    it('clicking Today in agenda mode switches to daily on today', async () => {
      // Start agenda mode on a non-today date so the mode switch is observable.
      useJournalStore.setState({ mode: 'agenda', currentDate: new Date('2026-03-15T12:00:00') })
      mockEmptyResponses()
      const user = userEvent.setup()

      renderJournal()
      await user.click(screen.getByRole('button', { name: /go to today/i }))

      expect(useJournalStore.getState().mode).toBe('daily')
      expect(format(useJournalStore.getState().currentDate, 'yyyy-MM-dd')).toBe('2026-04-20')
    })

    it('calendar date pick in agenda mode switches to daily on the picked date', async () => {
      useJournalStore.setState({ mode: 'agenda', currentDate: new Date('2026-04-20T12:00:00') })
      mockEmptyResponses()
      const user = userEvent.setup()

      renderJournal()

      // Open the calendar dropdown
      await user.click(screen.getByRole('button', { name: /open calendar picker/i }))
      await waitFor(() => {
        expect(screen.getByRole('grid')).toBeInTheDocument()
      })

      // react-day-picker renders each day as a button inside a gridcell.
      // Pick a known day in the current month (April 2026). We pick the
      // 15th to avoid colliding with the "today" cell (the 20th).
      const gridcells = screen.getAllByRole('gridcell')
      const day15Cell = gridcells.find((c) => c.textContent?.trim() === '15')
      expect(day15Cell).toBeDefined()
      const day15Button = day15Cell?.querySelector('button') as HTMLButtonElement
      expect(day15Button).toBeTruthy()
      await user.click(day15Button)

      expect(useJournalStore.getState().mode).toBe('daily')
      expect(format(useJournalStore.getState().currentDate, 'yyyy-MM-dd')).toBe('2026-04-15')
    })
  })

  // ── UX-236: redundant header buttons hidden when they are no-ops ─────
  describe('redundant header buttons (UX-236)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-04-20T12:00:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    describe('GlobalDateControls', () => {
      beforeEach(() => {
        mockEmptyResponses()
      })

      it('hides Today when on journal view + daily mode + today', () => {
        useNavigationStore.setState({
          currentView: 'journal',
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
        })
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })

        render(<GlobalDateControls />)

        expect(screen.queryByRole('button', { name: /go to today/i })).not.toBeInTheDocument()
      })

      it('shows Today when on journal view + daily mode + non-today date', () => {
        useNavigationStore.setState({
          currentView: 'journal',
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
        })
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })

        render(<GlobalDateControls />)

        expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
      })

      it('hides Agenda when on journal view + agenda mode', () => {
        useNavigationStore.setState({
          currentView: 'journal',
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
        })
        useJournalStore.setState({
          mode: 'agenda',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })

        render(<GlobalDateControls />)

        expect(screen.queryByRole('button', { name: /go to agenda/i })).not.toBeInTheDocument()
      })

      it('shows Agenda when not on journal view', () => {
        useNavigationStore.setState({
          currentView: 'pages',
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
        })
        useJournalStore.setState({
          mode: 'agenda',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })

        render(<GlobalDateControls />)

        expect(screen.getByRole('button', { name: /go to agenda/i })).toBeInTheDocument()
      })

      it('renders Today, Agenda, Calendar in that DOM order when all three are visible', () => {
        useNavigationStore.setState({
          currentView: 'pages',
          selectedBlockId: null,
        })
        useTabsStore.setState({
          tabs: [{ id: '0', pageStack: [], label: '' }],
          activeTabIndex: 0,
        })
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })

        render(<GlobalDateControls />)

        const todayBtn = screen.getByRole('button', { name: /go to today/i })
        const agendaBtn = screen.getByRole('button', { name: /go to agenda/i })
        const calBtn = screen.getByRole('button', { name: /open calendar picker/i })

        expect(
          todayBtn.compareDocumentPosition(agendaBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
        expect(
          agendaBtn.compareDocumentPosition(calBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
      })
    })

    describe('JournalControls', () => {
      it('hides Today when mode=daily on today', () => {
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.queryByRole('button', { name: /go to today/i })).not.toBeInTheDocument()
      })

      it('shows Today when mode=daily on non-today date', () => {
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
      })

      it('shows Today in weekly mode even when the week contains today', () => {
        useJournalStore.setState({
          mode: 'weekly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
      })

      it('shows Today in monthly mode even when the month contains today', () => {
        useJournalStore.setState({
          mode: 'monthly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
      })

      it('hides Agenda button in agenda mode but keeps Today + calendar visible', () => {
        useJournalStore.setState({
          mode: 'agenda',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.queryByRole('button', { name: /go to agenda/i })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /go to today/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /open calendar picker/i })).toBeInTheDocument()
      })

      it('shows Agenda button in daily mode', () => {
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to agenda/i })).toBeInTheDocument()
      })

      it('shows Agenda button in weekly mode', () => {
        useJournalStore.setState({
          mode: 'weekly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to agenda/i })).toBeInTheDocument()
      })

      it('shows Agenda button in monthly mode', () => {
        useJournalStore.setState({
          mode: 'monthly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('button', { name: /go to agenda/i })).toBeInTheDocument()
      })

      it('clicking Agenda calls navigateToDate(today, "agenda")', async () => {
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        const user = userEvent.setup()

        renderJournal()
        await user.click(screen.getByRole('button', { name: /go to agenda/i }))

        expect(useJournalStore.getState().mode).toBe('agenda')
        expect(format(useJournalStore.getState().currentDate, 'yyyy-MM-dd')).toBe('2026-04-20')
      })

      it('mode-switcher Agenda tab remains rendered in daily mode', () => {
        useJournalStore.setState({
          mode: 'daily',
          currentDate: new Date('2026-04-19T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
      })

      it('mode-switcher Agenda tab remains rendered in agenda mode', () => {
        useJournalStore.setState({
          mode: 'agenda',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
      })

      it('mode-switcher Agenda tab remains rendered in weekly mode', () => {
        useJournalStore.setState({
          mode: 'weekly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
      })

      it('mode-switcher Agenda tab remains rendered in monthly mode', () => {
        useJournalStore.setState({
          mode: 'monthly',
          currentDate: new Date('2026-04-20T12:00:00'),
          scrollToDate: null,
          scrollToPanel: null,
        })
        mockEmptyResponses()
        renderJournal()

        expect(screen.getByRole('tab', { name: /agenda view/i })).toBeInTheDocument()
      })
    })
  })

  // ── FEAT-3p5 — per-space currentDate / mode integration ─────────────
  //
  // The journal store's space-switch subscriber flushes the outgoing
  // space's flat fields into a slice and pulls the incoming space's
  // slice back into the flat fields. JournalPage renders straight from
  // the flat fields, so the date display + mode tab tracking should
  // follow the active space without any prop-drilling.

  describe('per-space slices (FEAT-3p5)', () => {
    it('switching from a space at 2025-01-15 to a fresh space falls back to today', async () => {
      // Arrange: Personal active, viewing 2025-01-15 in weekly mode.
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_PERSONAL',
        availableSpaces: [
          { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
          { id: 'SPACE_WORK', name: 'Work', accent_color: null },
        ],
        isReady: true,
      })
      useJournalStore.getState().navigateToDate(new Date(2025, 0, 15), 'weekly')
      mockEmptyResponses()
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Act: switch to Work — a space that has no slice yet.
      act(() => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' })
      })

      // Assert: store fell back to today + daily for the fresh space.
      const state = useJournalStore.getState()
      expect(state.mode).toBe('daily')
      // currentDate is "today" — match by ISO string instead of pinning
      // a calendar day so the test is stable across timezones / CI clocks.
      const today = new Date()
      const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const flatISO = `${state.currentDate.getFullYear()}-${String(state.currentDate.getMonth() + 1).padStart(2, '0')}-${String(state.currentDate.getDate()).padStart(2, '0')}`
      expect(flatISO).toBe(todayISO)

      // The outgoing Personal slice was flushed and round-trips correctly.
      expect(state.currentDateBySpace['SPACE_PERSONAL']).toBe('2025-01-15')
      expect(state.modeBySpace['SPACE_PERSONAL']).toBe('weekly')
    })

    it('switching back to a space restores its prior date + mode slice', async () => {
      // Arrange: visit Personal at 2025-01-15 weekly, then Work, then
      // back to Personal — the slice must round-trip.
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_PERSONAL',
        availableSpaces: [
          { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: null },
          { id: 'SPACE_WORK', name: 'Work', accent_color: null },
        ],
        isReady: true,
      })
      useJournalStore.getState().navigateToDate(new Date(2025, 0, 15), 'weekly')
      mockEmptyResponses()
      renderJournal()
      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Visit Work, change date inside it.
      act(() => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_WORK' })
      })
      act(() => {
        useJournalStore.getState().navigateToDate(new Date(2026, 5, 10), 'monthly')
      })

      // Switch back to Personal — flat fields must restore 2025-01-15 weekly.
      act(() => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
      })

      const state = useJournalStore.getState()
      expect(state.mode).toBe('weekly')
      expect(state.currentDate.getFullYear()).toBe(2025)
      expect(state.currentDate.getMonth()).toBe(0) // January
      expect(state.currentDate.getDate()).toBe(15)

      // And Work's slice still holds the 2026-06-10 monthly view.
      expect(state.currentDateBySpace['SPACE_WORK']).toBe('2026-06-10')
      expect(state.modeBySpace['SPACE_WORK']).toBe('monthly')
    })
  })

  // ── Configure journal template entry (UX-371) ───────────────────────

  describe('configure journal template entry (UX-371)', () => {
    it('renders the entry and clicking it opens the SpaceManageDialog', async () => {
      const user = userEvent.setup()
      mockEmptyResponses()

      renderJournal()

      await waitFor(() => {
        expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      })

      // Dialog is closed initially.
      expect(screen.queryByTestId('space-manage-mock')).not.toBeInTheDocument()

      // The entry is rendered inside JournalPage (data-testid keeps the
      // assertion unambiguous if a sibling control exposes the same label).
      const trigger = screen.getByTestId('journal-configure-template-trigger')
      expect(trigger).toHaveAccessibleName(/configure journal template/i)

      await user.click(trigger)

      expect(screen.getByTestId('space-manage-mock')).toBeInTheDocument()
    })
  })
})
