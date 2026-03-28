/**
 * Tests for JournalPage component.
 *
 * Validates:
 *  - Initial render with date navigation
 *  - Date navigation (prev/next/today)
 *  - Adding a block (form submit)
 *  - Deleting a block
 *  - Empty state
 *  - Loading state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
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

function makeBlock(id: string, content: string, parentId: string, position: number) {
  return {
    id,
    block_type: 'text',
    content,
    parent_id: parentId,
    position,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('JournalPage', () => {
  it("renders initial state with today's date", async () => {
    // First call: listBlocks({ blockType: 'page' }) — no daily page found
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

    // Should show the add block input
    expect(screen.getByPlaceholderText('Write something...')).toBeInTheDocument()
  })

  it('shows empty state when no blocks for current date', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })
  })

  it('shows loading state while fetching', async () => {
    // Make the mock never resolve to keep loading state visible
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    render(<JournalPage />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('renders blocks for the current date', async () => {
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)

    // First call: listBlocks({ blockType: 'page' }) — finds daily page
    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })
    // Second call: listBlocks({ parentId: 'DP1' }) — child blocks
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock('B1', 'First block', 'DP1', 0), makeBlock('B2', 'Second block', 'DP1', 1)],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    expect(await screen.findByText('First block')).toBeInTheDocument()
    expect(screen.getByText('Second block')).toBeInTheDocument()
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

  it('adds a block via the form', async () => {
    const user = userEvent.setup()
    const today = formatDate(new Date())

    // Initial load — no daily page
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<JournalPage />)

    await waitFor(() => {
      expect(screen.getByText(/No blocks for/)).toBeInTheDocument()
    })

    // Set up mocks for: create daily page + create block
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
        content: 'My journal entry',
        parent_id: 'DP1',
        position: 0,
      })

    // Type in the input and submit
    const input = screen.getByPlaceholderText('Write something...')
    await user.type(input, 'My journal entry')

    const addBtn = screen.getByRole('button', { name: /Add/i })
    await user.click(addBtn)

    // Block should appear in the list
    expect(await screen.findByText('My journal entry')).toBeInTheDocument()

    // Verify the create_block calls
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'page',
      content: today,
      parentId: null,
      position: null,
    })
    expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
      blockType: 'text',
      content: 'My journal entry',
      parentId: 'DP1',
      position: 0,
    })
  })

  it('deletes a block', async () => {
    const user = userEvent.setup()
    const today = formatDate(new Date())
    const dailyPage = makeDailyPage('DP1', today)

    // Initial load — daily page with 1 block
    mockedInvoke.mockResolvedValueOnce({
      items: [dailyPage],
      next_cursor: null,
      has_more: false,
    })
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock('B1', 'Block to delete', 'DP1', 0)],
      next_cursor: null,
      has_more: false,
    })

    render(<JournalPage />)

    expect(await screen.findByText('Block to delete')).toBeInTheDocument()

    // Mock delete_block response (for the child block) + delete daily page (auto-cleanup)
    mockedInvoke
      .mockResolvedValueOnce({
        block_id: 'B1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 1,
      })
      .mockResolvedValueOnce({
        block_id: 'DP1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

    // Find and click the delete button (it's a small icon button within the block row)
    // The button contains a Trash2 icon but no text — use the button within the block row
    const blockRow = screen.getByText('Block to delete').closest('div.group')
    const deleteBtn = blockRow?.querySelector('button') as HTMLButtonElement
    expect(deleteBtn).toBeTruthy()
    await user.click(deleteBtn)

    // Block should be removed
    await waitFor(() => {
      expect(screen.queryByText('Block to delete')).not.toBeInTheDocument()
    })
  })

  it('has no a11y violations', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    const { container } = render(<JournalPage />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
