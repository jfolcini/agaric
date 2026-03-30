/**
 * Tests for JournalPage component.
 *
 * Validates:
 *  - Initial render with date navigation
 *  - Date navigation (prev/next/today)
 *  - Renders BlockTree with correct parentId when daily page exists
 *  - Shows empty state when no daily page
 *  - Loading state while finding daily page
 *  - Add block button creates page + block and refreshes BlockTree
 *  - "Open in editor" button calls onNavigateToPage
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
// BlockTree is heavy (DnD, TipTap, viewport observer). Mock it to a
// simple div that exposes the parentId prop for verification.
let capturedParentId: string | undefined
vi.mock('../BlockTree', () => ({
  BlockTree: (props: { parentId?: string }) => {
    capturedParentId = props.parentId
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
  capturedParentId = undefined
  // Reset the Zustand store to a clean state before each test
  useBlockStore.setState({
    blocks: [],
    focusedBlockId: null,
    loading: false,
  })
})

describe('JournalPage', () => {
  it("renders initial state with today's date", async () => {
    // listBlocks({ blockType: 'page' }) — no daily page found
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    // Should show today's formatted date
    const today = new Date()
    const expectedDisplay = today.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

    await waitFor(() => {
      expect(screen.getByText(expectedDisplay)).toBeInTheDocument()
    })

    // Should show the Add block button
    expect(screen.getByRole('button', { name: /add block/i })).toBeInTheDocument()
  })

  it('shows empty state when no daily page for current date', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // BlockTree should NOT be rendered
    expect(screen.queryByTestId('block-tree')).not.toBeInTheDocument()
  })

  it('shows loading state while finding daily page', async () => {
    // Make the mock never resolve to keep loading state visible
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<JournalPage />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
  })

  it('renders BlockTree with correct parentId when daily page exists', async () => {
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)

    // listBlocks({ blockType: 'page' }) — finds daily page
    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
    })

    expect(screen.getByTestId('block-tree')).toHaveAttribute('data-parent-id', 'DP1')
    expect(capturedParentId).toBe('DP1')
  })

  it('navigates to previous day', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // Mock for prev day load
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const prevBtn = screen.getByRole('button', { name: /Prev/i })
    await user.click(prevBtn)

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const expectedDisplay = yesterday.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

    await waitFor(() => {
      expect(screen.getByText(expectedDisplay)).toBeInTheDocument()
    })
  })

  it('navigates to next day', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // Mock for next day load
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const nextBtn = screen.getByRole('button', { name: /Next/i })
    await user.click(nextBtn)

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const expectedDisplay = tomorrow.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

    await waitFor(() => {
      expect(screen.getByText(expectedDisplay)).toBeInTheDocument()
    })
  })

  it('navigates back to today after changing date', async () => {
    const user = userEvent.setup()
    // Initial load — empty
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // Navigate to prev day
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    const prevBtn = screen.getByRole('button', { name: /Prev/i })
    await user.click(prevBtn)

    // Today button should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Today/i })).toBeInTheDocument()
    })

    // Click Today
    mockedInvoke.mockResolvedValueOnce(emptyPage)
    await user.click(screen.getByRole('button', { name: /Today/i }))

    const todayDisplay = new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

    await waitFor(() => {
      expect(screen.getByText(todayDisplay)).toBeInTheDocument()
    })
  })

  it('does not show Today button when already on today', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /Today/i })).not.toBeInTheDocument()
  })

  it('add block button creates daily page and block when no page exists', async () => {
    const user = userEvent.setup()
    const today = formatDate(new Date())

    // Initial load — no daily page
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // Set up mocks for: create daily page + create child block + load(pageId)
    mockedInvoke
      // create_block for daily page
      .mockResolvedValueOnce({
        id: 'DP1',
        block_type: 'page',
        content: today,
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

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    // Verify the create_block calls
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'page',
        content: today,
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

    // After adding, BlockTree should appear with correct parentId
    await waitFor(() => {
      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
    })
    expect(screen.getByTestId('block-tree')).toHaveAttribute('data-parent-id', 'DP1')
  })

  it('add block button creates block under existing page', async () => {
    const user = userEvent.setup()
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)

    // Initial load — daily page exists
    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
    })

    // Set up mocks for: create child block + load(pageId)
    mockedInvoke
      // create_block for child text block (no page creation needed)
      .mockResolvedValueOnce({
        id: 'B2',
        block_type: 'text',
        content: '',
        parent_id: 'DP1',
        position: 1,
      })
      // load(pageId) — listBlocks({ parentId: 'DP1' })
      .mockResolvedValueOnce({
        items: [],
        next_cursor: null,
        has_more: false,
      })

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    // Should NOT have created a daily page — only the child block
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'DP1',
        position: null,
      })
    })

    // Should NOT have called create_block with blockType 'page' after initial load
    const createPageCalls = mockedInvoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'create_block' && (args as { blockType: string }).blockType === 'page',
    )
    expect(createPageCalls).toHaveLength(0)
  })

  it('shows "Open in editor" button when daily page exists and onNavigateToPage provided', async () => {
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)
    const onNavigateToPage = vi.fn()

    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage onNavigateToPage={onNavigateToPage} />)

    await waitFor(() => {
      expect(screen.getByTestId('block-tree')).toBeInTheDocument()
    })

    const openBtn = screen.getByRole('button', { name: /open in editor/i })
    expect(openBtn).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(openBtn)

    expect(onNavigateToPage).toHaveBeenCalledWith('DP1', today)
  })

  it('does not show "Open in editor" button when no daily page', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage onNavigateToPage={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: /open in editor/i })).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const { container } = render(<JournalPage />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when daily page exists', async () => {
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)

    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })

    const { container } = render(<JournalPage onNavigateToPage={() => {}} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
