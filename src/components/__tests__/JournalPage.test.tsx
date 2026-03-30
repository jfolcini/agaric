/**
 * Tests for JournalPage component (multi-day scrollable view).
 *
 * Validates:
 *  - Renders 7 day sections (today + 6 past days)
 *  - Today gets prominent header (h2), past days get smaller (h3)
 *  - BlockTree rendered with correct parentId for days that have pages
 *  - Empty state shown for days without pages
 *  - Each day section has its own "Add block" button
 *  - "Add block" creates page + block for that day
 *  - "Load older days" button loads 7 more days
 *  - Loading state while fetching pages
 *  - "Open in editor" button calls onNavigateToPage
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
// BlockTree is heavy (DnD, TipTap, viewport observer). Mock it to a
// simple div that exposes the parentId prop for verification.
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string }) => {
    return (
      <div data-testid="block-tree" data-parent-id={props.parentId ?? ''} className="block-tree" />
    )
  },
}))

import { useBlockStore } from '../../stores/blocks'
import { JournalPage } from '../JournalPage'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

/** Format a Date as YYYY-MM-DD (mirrors the component's formatDate). */
function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

/** Build a Date for N days ago. */
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
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
  // Reset the Zustand store to a clean state before each test
  useBlockStore.setState({
    blocks: [],
    focusedBlockId: null,
    loading: false,
  })
})

describe('JournalPage', () => {
  it('renders 7 day sections with correct dates', async () => {
    // listBlocks({ blockType: 'page' }) — no daily pages found
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // Should have 7 day sections
    const sections = screen.getAllByRole('region')
    expect(sections).toHaveLength(7)

    // First section should be today
    const todayDisplay = formatDateDisplay(new Date())
    expect(sections[0]).toHaveAccessibleName(`Journal for ${todayDisplay}`)

    // Last section should be 6 days ago
    const sixDaysAgoDisplay = formatDateDisplay(daysAgo(6))
    expect(sections[6]).toHaveAccessibleName(`Journal for ${sixDaysAgoDisplay}`)
  })

  it('renders today with prominent h2 header and past days with h3', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    const todayDisplay = formatDateDisplay(new Date())

    // Today should be an h2
    const h2s = screen.getAllByRole('heading', { level: 2 })
    expect(h2s).toHaveLength(1)
    expect(h2s[0].textContent).toBe(todayDisplay)

    // Past days should be h3
    const h3s = screen.getAllByRole('heading', { level: 3 })
    expect(h3s).toHaveLength(6)
  })

  it('shows empty state with "No blocks" for days without pages', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // All 7 days should show "No blocks for" text
    const noBlocksTexts = screen.getAllByText(/No blocks for/)
    expect(noBlocksTexts).toHaveLength(7)

    // No BlockTree should be rendered
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
  })

  it('renders BlockTree for days that have pages', async () => {
    const todayStr = formatDate(new Date())
    const yesterdayStr = formatDate(daysAgo(1))

    mockedInvoke.mockResolvedValueOnce({
      items: [makeDailyPage('DP-TODAY', todayStr), makeDailyPage('DP-YESTERDAY', yesterdayStr)],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    await waitFor(() => {
      const trees = screen.getAllByTestId('block-tree')
      expect(trees).toHaveLength(2)
    })

    const trees = screen.getAllByTestId('block-tree')
    expect(trees[0]).toHaveAttribute('data-parent-id', 'DP-TODAY')
    expect(trees[1]).toHaveAttribute('data-parent-id', 'DP-YESTERDAY')

    // Days without pages still show empty state
    const noBlocksTexts = screen.getAllByText(/No blocks for/)
    expect(noBlocksTexts).toHaveLength(5) // 7 days - 2 with pages = 5
  })

  it('shows loading state while fetching pages', () => {
    // Make the mock never resolve to keep loading state visible
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<JournalPage />)

    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('each day section has its own "Add block" button', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // 7 "Add block" buttons (one per day) + 7 "Add your first block" buttons (all days empty)
    const addBlockBtns = screen.getAllByRole('button', { name: /add block/i })
    expect(addBlockBtns).toHaveLength(7)

    const addFirstBtns = screen.getAllByRole('button', { name: /add your first block/i })
    expect(addFirstBtns).toHaveLength(7)
  })

  it('add block creates daily page and block when no page exists for that day', async () => {
    const user = userEvent.setup()
    const todayStr = formatDate(new Date())

    // Initial load — no daily pages
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // Set up mocks for: create daily page + create child block + load(pageId)
    mockedInvoke
      // create_block for daily page
      .mockResolvedValueOnce({
        id: 'DP1',
        block_type: 'page',
        content: todayStr,
        parent_id: null,
        position: null,
      })
      // create_block for child text block
      .mockResolvedValueOnce({
        id: 'B1',
        block_type: 'text',
        content: '',
        parent_id: 'DP1',
        position: 0,
      })
      // load(pageId) — listBlocks({ parentId: 'DP1' })
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

    // Click the first "Add block" button (today's section)
    const sections = screen.getAllByRole('region')
    const todaySection = sections[0]
    const addBtn = within(todaySection).getByRole('button', { name: /^add block$/i })
    await user.click(addBtn)

    // Verify the create_block calls
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

  it('add block creates block under existing page without creating new page', async () => {
    const user = userEvent.setup()
    const todayStr = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', todayStr)

    // Initial load — today's page exists
    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
    })

    // Set up mocks for: create child block + load(pageId)
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

    // Click the "Add block" button in today's section
    const sections = screen.getAllByRole('region')
    const todaySection = sections[0]
    const addBtn = within(todaySection).getByRole('button', { name: /^add block$/i })
    await user.click(addBtn)

    // Should NOT have called create_block with blockType 'page' after initial load
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

  it('"Load older days" button loads 7 more days', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    // Initially 7 sections
    expect(screen.getAllByRole('region')).toHaveLength(7)

    // Click "Load older days"
    const loadMoreBtn = screen.getByRole('button', { name: /load older days/i })
    await user.click(loadMoreBtn)

    // Now 14 sections
    expect(screen.getAllByRole('region')).toHaveLength(14)
  })

  it('shows "Open in editor" button for days that have pages', async () => {
    const todayStr = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', todayStr)
    const onNavigateToPage = vi.fn()

    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage onNavigateToPage={onNavigateToPage} />)

    await waitFor(() => {
      expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
    })

    const openBtn = screen.getByRole('button', { name: new RegExp(`Open ${todayStr} in editor`) })
    expect(openBtn).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(openBtn)

    expect(onNavigateToPage).toHaveBeenCalledWith('DP1', todayStr)
  })

  it('does not show "Open in editor" button for days without pages', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage onNavigateToPage={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /open .* in editor/i })).not.toBeInTheDocument()
  })

  it('has no a11y violations (empty state)', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const { container } = render(<JournalPage />)

    await waitFor(async () => {
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument()
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when daily pages exist', async () => {
    const todayStr = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', todayStr)

    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    const { container } = render(<JournalPage onNavigateToPage={() => {}} />)

    await waitFor(async () => {
      expect(screen.getAllByTestId('block-tree')).toHaveLength(1)
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
