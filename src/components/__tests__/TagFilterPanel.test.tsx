/**
 * Tests for TagFilterPanel component.
 *
 * Validates:
 *  - Prefix input rendering
 *  - Tag search by prefix (debounced)
 *  - Adding a tag to selection
 *  - Removing a tag from selection
 *  - AND/OR/NOT mode toggle
 *  - Querying blocks on tag selection
 *  - Pagination (Load more)
 *  - Empty results state
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { makeBlock } from '../../__tests__/fixtures'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { TagFilterPanel } from '../TagFilterPanel'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

const makeTag = (overrides?: Partial<Record<string, unknown>>) => ({
  tag_id: 'TAG001',
  name: 'work',
  usage_count: 5,
  updated_at: '2025-01-15T00:00:00Z',
  ...overrides,
})

const emptyPage = { items: [], next_cursor: null, has_more: false }

/**
 * Find a matching-tag <span> in the tag list by its full textContent.
 * Needed because HighlightPrefix splits text across <strong> + text nodes,
 * which breaks getByText's direct-text-node matching.
 */
function findTagSpan(regex: RegExp): HTMLElement | null {
  const spans = document.querySelectorAll('.tag-filter-panel .space-y-1 span')
  return (Array.from(spans).find((el) => regex.test(el.textContent ?? '')) as HTMLElement) ?? null
}

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

let user: ReturnType<typeof userEvent.setup>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  useNavigationStore.setState({
    currentView: 'search',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
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

  it('renders AND/OR/NOT mode toggle', () => {
    render(<TagFilterPanel />)
    expect(screen.getByRole('button', { name: /AND/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /OR/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /NOT/i })).toBeInTheDocument()
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
      limit: null,
    })

    expect(findTagSpan(/work\/meeting/)).toBeInTheDocument()
  })

  it('highlights matching prefix in tag names', async () => {
    mockedInvoke.mockResolvedValue([
      makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 }),
      makeTag({ tag_id: 'T2', name: 'work/meeting', usage_count: 3 }),
    ])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    // The matching portion should be bolded
    const strongElements = document.querySelectorAll('.tag-filter-panel strong')
    expect(strongElements.length).toBeGreaterThanOrEqual(2)
    expect(strongElements[0]?.textContent).toBe('work')
  })

  it('clears matching tags when prefix cleared', async () => {
    mockedInvoke.mockResolvedValue([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    expect(findTagSpan(/work \(5\)/)).toBeInTheDocument()

    // Clear the input
    fireEvent.change(input, { target: { value: '' } })

    expect(findTagSpan(/work \(5\)/)).toBeNull()
  })

  it('adds a tag to selection when Add is clicked', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // Mock query_by_tags for when tag is selected
    mockedInvoke.mockResolvedValue(emptyPage)

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

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

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Badge should be present
    const removeBtn = screen.getByLabelText('Remove tag work')

    await user.click(removeBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Badge should be gone
    expect(screen.queryByText('Selected:')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove tag work')).not.toBeInTheDocument()
  })

  it('toggles AND/OR/NOT mode', async () => {
    render(<TagFilterPanel />)

    const andBtn = screen.getByRole('button', { name: /AND/i })
    const orBtn = screen.getByRole('button', { name: /OR/i })
    const notBtn = screen.getByRole('button', { name: /NOT/i })

    // AND is default active
    expect(andBtn).toHaveAttribute('aria-pressed', 'true')
    expect(orBtn).toHaveAttribute('aria-pressed', 'false')
    expect(notBtn).toHaveAttribute('aria-pressed', 'false')

    // Switch to OR
    await user.click(orBtn)

    expect(andBtn).toHaveAttribute('aria-pressed', 'false')
    expect(orBtn).toHaveAttribute('aria-pressed', 'true')
    expect(notBtn).toHaveAttribute('aria-pressed', 'false')

    // Switch to NOT
    await user.click(notBtn)

    expect(andBtn).toHaveAttribute('aria-pressed', 'false')
    expect(orBtn).toHaveAttribute('aria-pressed', 'false')
    expect(notBtn).toHaveAttribute('aria-pressed', 'true')

    // Switch back to AND
    await user.click(andBtn)

    expect(andBtn).toHaveAttribute('aria-pressed', 'true')
    expect(orBtn).toHaveAttribute('aria-pressed', 'false')
    expect(notBtn).toHaveAttribute('aria-pressed', 'false')
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

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['T1'],
      prefixes: [],
      mode: 'and',
      includeInherited: null,
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

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('first result')).toBeInTheDocument()
    const loadMoreBtn = screen.getByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    // Second page
    mockedInvoke.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B2', content: 'second result' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(loadMoreBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['T1'],
      prefixes: [],
      mode: 'and',
      includeInherited: null,
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

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('No matching blocks found.')).toBeInTheDocument()
  })

  it('does not show results before any tag is selected', () => {
    render(<TagFilterPanel />)
    expect(screen.queryByText('No matching blocks found.')).not.toBeInTheDocument()
    expect(screen.queryByText('Results')).not.toBeInTheDocument()
  })

  it('shows "Select tags above" feedback when no tags are selected', () => {
    render(<TagFilterPanel />)
    expect(screen.getByText('Select tags above to filter blocks')).toBeInTheDocument()
  })

  it('shows match summary feedback when tags are selected and results exist', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results
    mockedInvoke.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'result one' }),
        makeBlock({ id: 'B2', content: 'result two' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Should show feedback: "2 blocks match 1 tag (AND)"
    expect(screen.getByTestId('tag-filter-feedback')).toHaveTextContent(
      '2 blocks match 1 tag (AND)',
    )
  })

  it('shows singular feedback when 1 result matches 1 tag', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns exactly 1 result
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'only result' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Should show singular: "1 block matches 1 tag (AND)"
    expect(screen.getByTestId('tag-filter-feedback')).toHaveTextContent(
      '1 block matches 1 tag (AND)',
    )
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

  it('shows error toast when tag loading fails', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    fireEvent.change(input, { target: { value: 'fail' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockedToastError).toHaveBeenCalledWith('Failed to load tags')
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
    expect(findTagSpan(/work \(5\)/)).toBeInTheDocument()
    expect(findTagSpan(/work\/meeting \(3\)/)).toBeInTheDocument()

    // Add the first tag
    const addBtns = screen.getAllByRole('button', { name: /Add/i })

    // Mock query_by_tags response for when tag is selected
    mockedInvoke.mockResolvedValue(emptyPage)

    await user.click(addBtns[0] as HTMLElement)
    await vi.advanceTimersByTimeAsync(0)

    // First tag should be removed from matching list (it's now in selected)
    expect(findTagSpan(/work \(5\)/)).toBeNull()
    // Second tag should still be in matching list
    expect(findTagSpan(/work\/meeting \(3\)/)).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    vi.useRealTimers()
    const { container } = render(<TagFilterPanel />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('navigates to parent page when clicking a tag filter result', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns a block with parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeBlock({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'tagged content',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('tagged content')).toBeInTheDocument()

    // Mock get_block for parent lookup
    mockedInvoke.mockResolvedValueOnce({
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page',
      parent_id: null,
      position: 0,
      deleted_at: null,
      is_conflict: false,
    })

    await user.click(screen.getByText('tagged content'))
    await vi.advanceTimersByTimeAsync(0)

    expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'PARENT1' })

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(navState)[0]?.pageId).toBe('PARENT1')
    expect(selectPageStack(navState)[0]?.title).toBe('Parent Page')
    expect(navState.selectedBlockId).toBe('CHILD1')
  })

  it('navigates directly when clicking a page-type tag filter result', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns a page block
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeBlock({
          id: 'PAGE1',
          parent_id: null,
          content: 'My Tagged Page',
          block_type: 'page',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('My Tagged Page')).toBeInTheDocument()

    await user.click(screen.getByText('My Tagged Page'))
    await vi.advanceTimersByTimeAsync(0)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(navState)[0]?.pageId).toBe('PAGE1')
    expect(selectPageStack(navState)[0]?.title).toBe('My Tagged Page')
    expect(navState.selectedBlockId).toBeNull()
  })

  // -- NOT mode specific tests --------------------------------------------------

  it('clicking NOT button calls queryByTags with mode=not', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results (initial AND mode)
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'work item' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Switch to NOT mode
    const notBtn = screen.getByRole('button', { name: /^NOT$/i })
    await user.click(notBtn)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockedInvoke).toHaveBeenCalledWith('query_by_tags', {
      tagIds: ['T1'],
      prefixes: [],
      mode: 'not',
      includeInherited: null,
      cursor: null,
      limit: 50,
    })
  })

  it('shows match summary with (NOT) when mode is not', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    // Switch to NOT mode first
    const notBtn = screen.getByRole('button', { name: /^NOT$/i })
    await user.click(notBtn)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results
    mockedInvoke.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'result one' }),
        makeBlock({ id: 'B2', content: 'result two' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Should show feedback with (NOT)
    expect(screen.getByTestId('tag-filter-feedback')).toHaveTextContent(
      '2 blocks match 1 tag (NOT)',
    )
  })

  it('switching from NOT to AND updates query', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    // Switch to NOT mode first
    const notBtn = screen.getByRole('button', { name: /^NOT$/i })
    await user.click(notBtn)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results in NOT mode
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'excluded result' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Verify NOT mode was used
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ mode: 'not' }),
    )

    // Switch to AND mode
    const andBtn = screen.getByRole('button', { name: /^AND$/i })
    await user.click(andBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Verify AND mode is now used
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ mode: 'and' }),
    )
  })

  it('switching from NOT to OR updates query', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    // Switch to NOT mode first
    const notBtn = screen.getByRole('button', { name: /^NOT$/i })
    await user.click(notBtn)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results in NOT mode
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'excluded result' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Switch to OR mode
    const orBtn = screen.getByRole('button', { name: /^OR$/i })
    await user.click(orBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Verify OR mode is now used
    expect(mockedInvoke).toHaveBeenCalledWith(
      'query_by_tags',
      expect.objectContaining({ mode: 'or' }),
    )
  })

  // -- Keyboard interaction tests -----------------------------------------------
  // Note: TagFilterPanel does not implement custom arrow-key navigation in tag
  // results or Escape to dismiss. All interactive elements are standard HTML
  // buttons and inputs, so keyboard access works via native Tab + Enter/Space.

  describe('keyboard interaction', () => {
    it('search input is keyboard-accessible with proper aria-label', () => {
      render(<TagFilterPanel />)
      const input = screen.getByLabelText('Search tags by prefix')
      expect(input.tagName).toBe('INPUT')
      input.focus()
      expect(document.activeElement).toBe(input)
    })

    it('tag results contain focusable Add buttons', async () => {
      mockedInvoke.mockResolvedValueOnce([
        makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 }),
        makeTag({ tag_id: 'T2', name: 'personal', usage_count: 3 }),
      ])
      render(<TagFilterPanel />)

      const input = screen.getByPlaceholderText('Search tags by prefix...')
      await typeAndWaitForTags(input, 'work')

      const addBtns = screen.getAllByRole('button', { name: /Add/i })
      expect(addBtns).toHaveLength(2)
      // Each is a real <button> reachable via Tab
      for (const btn of addBtns) {
        expect(btn.tagName).toBe('BUTTON')
      }
    })

    it('selected tag remove button has accessible label for keyboard users', async () => {
      mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])
      render(<TagFilterPanel />)

      const input = screen.getByPlaceholderText('Search tags by prefix...')
      await typeAndWaitForTags(input, 'work')

      mockedInvoke.mockResolvedValue(emptyPage)

      await user.click(screen.getByRole('button', { name: /Add/i }))
      await vi.advanceTimersByTimeAsync(0)

      // Remove button has aria-label for screen readers and keyboard users
      const removeBtn = screen.getByLabelText('Remove tag work')
      expect(removeBtn.tagName).toBe('BUTTON')
      expect(removeBtn).toHaveAttribute('type', 'button')
    })
  })

  it('matching tags section uses <section> element', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    // The "Matching tags" heading should be inside a <section>
    const heading = screen.getByText('Matching tags')
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    expect(section?.tagName).toBe('SECTION')
    expect(section).toHaveClass('rounded-lg', 'border', 'bg-card', 'p-3')
  })

  it('results section uses <section> element', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // query_by_tags returns results
    mockedInvoke.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'result one' })],
      next_cursor: null,
      has_more: false,
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // The results heading should be inside a <section>
    const heading = screen.getByText(/Results \(1\)/)
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    expect(section?.tagName).toBe('SECTION')
    expect(section).toHaveClass('tag-filter-results', 'space-y-3')
  })

  // -----------------------------------------------------------------------
  // Escape key clears search
  // -----------------------------------------------------------------------
  it('pressing Escape on search input clears the search and results', async () => {
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    // Matching tags should be visible
    expect(findTagSpan(/work \(5\)/)).toBeInTheDocument()

    // Press Escape
    fireEvent.keyDown(input, { key: 'Escape' })

    // Search input should be cleared
    expect(input).toHaveValue('')
    // Matching tags should be gone
    expect(findTagSpan(/work \(5\)/)).toBeNull()
  })

  it('has no a11y violations with search results visible', async () => {
    vi.useRealTimers()
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    const { container } = render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    fireEvent.change(input, { target: { value: 'work' } })

    // Wait for debounce without fake timers
    await new Promise((r) => setTimeout(r, 350))

    // Wait for matching tags to render
    await waitFor(() => {
      expect(findTagSpan(/work \(5\)/)).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -- UX-71: Breadcrumb tests ---------------------------------------------------

  it('renders page breadcrumbs for results', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // Use mockImplementation so query_by_tags and batch_resolve both resolve correctly
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [
            makeBlock({
              id: 'B1',
              parent_id: 'PAGE1',
              content: 'tagged block',
              block_type: 'content',
            }),
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE1', title: 'My Page', block_type: 'page', deleted: false }]
      }
      return null
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Wait for breadcrumb to appear
    await waitFor(() => {
      expect(screen.getByText('in:')).toBeInTheDocument()
    })

    // Page title should be rendered as a link
    expect(screen.getByRole('link', { name: 'My Page' })).toBeInTheDocument()
  })

  it('handles batchResolve failure gracefully', async () => {
    // list_tags_by_prefix response
    mockedInvoke.mockResolvedValueOnce([makeTag({ tag_id: 'T1', name: 'work', usage_count: 5 })])

    render(<TagFilterPanel />)

    const input = screen.getByPlaceholderText('Search tags by prefix...')
    await typeAndWaitForTags(input, 'work')

    const addBtn = screen.getByRole('button', { name: /Add/i })

    // Use mockImplementation: query_by_tags succeeds, batch_resolve rejects
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'query_by_tags') {
        return {
          items: [
            makeBlock({
              id: 'B1',
              parent_id: 'PAGE1',
              content: 'tagged block',
              block_type: 'content',
            }),
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'batch_resolve') {
        throw new Error('resolve failed')
      }
      return null
    })

    await user.click(addBtn)
    await vi.advanceTimersByTimeAsync(0)

    // Results should still be shown despite batch_resolve failure
    expect(screen.getByText('tagged block')).toBeInTheDocument()

    // No breadcrumb should appear (batch_resolve failed)
    expect(screen.queryByText('in:')).not.toBeInTheDocument()
  })
})
