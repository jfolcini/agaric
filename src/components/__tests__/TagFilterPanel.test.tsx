/**
 * Tests for TagFilterPanel component.
 *
 * Validates:
 *  - Prefix input rendering
 *  - Tag search by prefix (debounced)
 *  - Adding a tag to selection
 *  - Removing a tag from selection
 *  - AND/OR mode toggle
 *  - Querying blocks on tag selection
 *  - Pagination (Load more)
 *  - Empty results state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TagFilterPanel } from '../TagFilterPanel'

const mockedInvoke = vi.mocked(invoke)

const makeTag = (overrides?: Partial<Record<string, unknown>>) => ({
  tag_id: 'TAG001',
  name: 'work',
  usage_count: 5,
  updated_at: '2025-01-15T00:00:00Z',
  ...overrides,
})

const makeBlock = (overrides?: Partial<Record<string, unknown>>) => ({
  id: 'BLOCK1',
  block_type: 'content',
  content: 'test content',
  parent_id: null,
  position: 1,
  deleted_at: null,
  archived_at: null,
  is_conflict: false,
  ...overrides,
})

const emptyPage = { items: [], next_cursor: null, has_more: false }

/**
 * Helper: type a prefix and wait for the debounced search to fire + resolve.
 * Uses fake timers internally, restores real timers before returning.
 */
async function typeAndWaitForTags(input: HTMLElement, prefix: string): Promise<void> {
  fireEvent.change(input, { target: { value: prefix } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TagFilterPanel', () => {
  it('renders prefix input', () => {
    render(<TagFilterPanel />)
    expect(screen.getByPlaceholderText('Search tags by prefix...')).toBeInTheDocument()
  })

  it('renders Tag Filter heading', () => {
    render(<TagFilterPanel />)
    expect(screen.getByText('Tag Filter')).toBeInTheDocument()
  })

  it('renders AND/OR mode toggle', () => {
    render(<TagFilterPanel />)
    expect(screen.getByRole('button', { name: /AND/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /OR/i })).toBeInTheDocument()
  })

  it('searches tags by prefix with debounce', async () => {
    mockedInvoke.mockResolvedValue([
      makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 }),
      makeTag({ tag_id: 'T2', name: 'work/meeting', usage_count: 3 }),
    ])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    fireEvent.change(input, { target: { value: 'work' } })

    // Not yet called — debounce timer hasn't fired
    expect(mockedInvoke).not.toHaveBeenCalled()

    // Advance past the 300ms debounce and flush microtasks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('list_tags_by_prefix', {
      prefix: 'work',
    })

    expect(screen.getByText(/work\/meeting/)).toBeInTheDocument()
  })

  it('clears matching tags when prefix cleared', async () => {
    mockedInvoke.mockResolvedValue([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    expect(screen.getByText(/work \(5\)/)).toBeInTheDocument()

    // Clear the input
    fireEvent.change(input, { target: { value: '' } })

    expect(screen.queryByText(/work \(5\)/)).not.toBeInTheDocument()
  })

  it('adds a tag to selection when Add is clicked', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // Mock query_by_tags for when tag is selected
    mockedInvoke.mockResolvedValue(emptyPage)

    await act(async () => {
      fireEvent.click(addBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    // Tag badge should appear in selected section
    expect(screen.getByText('Selected:')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove tag work')).toBeInTheDocument()
  })

  it('removes a tag from selection when × is clicked', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    mockedInvoke.mockResolvedValue(emptyPage)

    await act(async () => {
      fireEvent.click(addBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    // Badge should be present
    const removeBtn = screen.getByLabelText('Remove tag work')

    await act(async () => {
      fireEvent.click(removeBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    // Badge should be gone
    expect(screen.queryByText('Selected:')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove tag work')).not.toBeInTheDocument()
  })

  it('toggles AND/OR mode', async () => {
    render(<TagFilterPanel />)

    const andBtn = screen.getByRole('button', { name: /AND/i })
    const orBtn = screen.getByRole('button', { name: /OR/i })

    // AND is default active
    expect(andBtn).toHaveAttribute('aria-pressed', 'true')
    expect(orBtn).toHaveAttribute('aria-pressed', 'false')

    // Switch to OR
    await act(async () => {
      fireEvent.click(orBtn)
    })

    expect(andBtn).toHaveAttribute('aria-pressed', 'false')
    expect(orBtn).toHaveAttribute('aria-pressed', 'true')

    // Switch back to AND
    await act(async () => {
      fireEvent.click(andBtn)
    })

    expect(andBtn).toHaveAttribute('aria-pressed', 'true')
    expect(orBtn).toHaveAttribute('aria-pressed', 'false')
  })

  it('queries blocks when a tag is selected', async () => {
    // First call: list_tags_by_prefix
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // Next call: query_by_tags
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'work note' })],
      next_cursor: null,
      has_more: false,
    })

    await act(async () => {
      fireEvent.click(addBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['T1'],
      prefixes: [],
      mode: 'and',
      cursor: null,
      limit: 50,
    })

    expect(screen.getByText('work note')).toBeInTheDocument()
  })

  it('paginates results with Load more', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // First page of query_by_tags
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', content: 'first result' })],
      next_cursor: 'cursor_abc',
      has_more: true,
    })

    await act(async () => {
      fireEvent.click(addBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText('first result')).toBeInTheDocument()
    const loadMoreBtn = screen.getByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    // Second page
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B2', content: 'second result' })],
      next_cursor: null,
      has_more: false,
    })

    await act(async () => {
      fireEvent.click(loadMoreBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['T1'],
      prefixes: [],
      mode: 'and',
      cursor: 'cursor_abc',
      limit: 50,
    })

    // Both results should be accumulated
    expect(screen.getByText('first result')).toBeInTheDocument()
    expect(screen.getByText('second result')).toBeInTheDocument()

    // Load More should disappear after last page
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('shows empty results message when no blocks match', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns empty
    mockedInvoke.mockResolvedValue(emptyPage)

    await act(async () => {
      fireEvent.click(addBtn)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText('No matching blocks found.')).toBeInTheDocument()
  })

  it('does not show results before any tag is selected', () => {
    render(<TagFilterPanel />)
    expect(screen.queryByText('No matching blocks found.')).not.toBeInTheDocument()
    expect(screen.queryByText('Results')).not.toBeInTheDocument()
  })

  it('does not crash on search error', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    fireEvent.change(input, { target: { value: 'fail' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // Component should not crash
    expect(screen.getByPlaceholderText('Search tags by prefix...')).toBeInTheDocument()
  })

  it('hides already-selected tags from matching results', async () => {
    mockedInvoke.mockResolvedValueOnce([
      makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 }),
      makeTag({ tag_id: 'T2', name: 'work/meeting', usage_count: 3 }),
    ])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    // Both tags visible
    expect(screen.getByText(/work \(5\)/)).toBeInTheDocument()
    expect(screen.getByText(/work\/meeting \(3\)/)).toBeInTheDocument()

    // Add the first tag
    const addBtns = screen.getAllByRole('button', { name: /Add/i })

    // Mock query_by_tags response for when tag is selected
    mockedInvoke.mockResolvedValue(emptyPage)

    await act(async () => {
      fireEvent.click(addBtns[0])
      await vi.advanceTimersByTimeAsync(0)
    })

    // First tag should be removed from matching list (it's now in selected)
    expect(screen.queryByText(/work \(5\)/)).not.toBeInTheDocument()
    // Second tag should still be in matching list
    expect(screen.getByText(/work\/meeting \(3\)/)).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    vi.useRealTimers()
    const { container } = render(<TagFilterPanel />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
