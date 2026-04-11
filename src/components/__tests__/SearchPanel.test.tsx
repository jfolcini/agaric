/**
 * Tests for SearchPanel component.
 *
 * Validates:
 *  - Search input rendering
 *  - Form submit search
 *  - Button click search
 *  - Empty results state
 *  - Loading state
 *  - Debounced search on input change
 *  - Pagination (Load more)
 *  - Clearing results when input cleared
 *  - CJK notice shown/hidden
 *  - Search button disabled when empty
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { addRecentPage } from '../../lib/recent-pages'
import { useNavigationStore } from '../../stores/navigation'
import { SearchPanel } from '../SearchPanel'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

const makeSearchResult = (overrides?: Partial<Record<string, unknown>>) => ({
  id: 'BLOCK1',
  block_type: 'content',
  content: 'test content',
  parent_id: null,
  position: 1,
  deleted_at: null,
  is_conflict: false,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useNavigationStore.setState({
    currentView: 'search',
    pageStack: [],
    selectedBlockId: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Helper: set query via fireEvent.change and immediately submit the form.
 * This avoids userEvent timing issues with the debounce timer.
 */
function typeAndSubmit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  const form = input.closest('form')
  if (form) fireEvent.submit(form)
}

/**
 * Custom text matcher for content broken up by child elements (e.g., <mark> highlights).
 * RTL's getByText only checks direct text node children; this checks full textContent.
 * Returns the innermost element whose textContent equals the given text.
 */
function textContent(text: string) {
  return (_content: string, element: Element | null) => {
    if (!element) return false
    const hasMatch = element.textContent === text
    // Only match the innermost element — exclude parents whose children also match.
    const childAlsoMatches = Array.from(element.children).some(
      (child) => child.textContent === text,
    )
    return hasMatch && !childAlsoMatches
  }
}

describe('SearchPanel', () => {
  it('renders search input', () => {
    render(<SearchPanel />)
    expect(screen.getByPlaceholderText('Search blocks...')).toBeInTheDocument()
  })

  it('shows no results before first search', () => {
    render(<SearchPanel />)
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument()
  })

  it('searches via form submit', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'test',
        parentId: null,
        tagIds: null,
        cursor: null,
        limit: 50,
      })
    })

    await waitFor(() => {
      expect(screen.getByText(textContent('test content'))).toBeInTheDocument()
    })
  })

  it('searches via button click', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockResolvedValue({
      items: [makeSearchResult({ id: 'B2', content: 'button result' })],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: 'query' } })

    const searchBtn = screen.getByRole('button', { name: /Search/i })
    await user.click(searchBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'query',
        parentId: null,
        tagIds: null,
        cursor: null,
        limit: 50,
      })
    })

    await waitFor(() => {
      expect(screen.getByText('button result')).toBeInTheDocument()
    })
  })

  it('shows "No results found." for empty results', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'nothing')

    await waitFor(() => {
      expect(screen.getByText(/No results found/)).toBeInTheDocument()
    })
  })

  it('shows skeleton loaders while loading', () => {
    // Never resolve to keep loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'slow')

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(2)
  })

  it('paginates with "Load more"', async () => {
    const user = userEvent.setup()

    const page1 = {
      items: [makeSearchResult({ id: 'B1', content: 'first result' })],
      next_cursor: 'cursor_abc',
      has_more: true,
    }
    const page2 = {
      items: [makeSearchResult({ id: 'B2', content: 'second result' })],
      next_cursor: null,
      has_more: false,
    }

    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'result')

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'result',
        parentId: null,
        tagIds: null,
        cursor: 'cursor_abc',
        limit: 50,
      })
    })

    // Both results should be rendered (accumulated)
    await waitFor(() => {
      expect(screen.getByText(textContent('first result'))).toBeInTheDocument()
      expect(screen.getByText(textContent('second result'))).toBeInTheDocument()
    })

    // Load More should disappear after last page
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('debounces search on input change', async () => {
    vi.useFakeTimers()

    mockedInvoke.mockResolvedValue({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: 'debounce' } })

    // Not yet called — debounce timer hasn't fired
    expect(mockedInvoke).not.toHaveBeenCalled()

    // Advance past the 300ms debounce and flush promises
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'debounce',
      parentId: null,
      tagIds: null,
      cursor: null,
      limit: 50,
    })
  })

  it('clears results when input cleared', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText(textContent('test content'))).toBeInTheDocument()
    })

    // Clear the input — triggers onChange with empty value, which resets results
    fireEvent.change(input, { target: { value: '' } })

    await waitFor(() => {
      expect(screen.queryByText(textContent('test content'))).not.toBeInTheDocument()
      expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
    })
  })

  it('shows CJK notice for CJK input', () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: '你好' } })

    expect(screen.getByText(/CJK search is limited/)).toBeInTheDocument()
  })

  it('does not show CJK notice for Latin input', () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: 'hello' } })

    expect(screen.queryByText(/CJK search is limited/)).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<SearchPanel />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('disables search button when input is empty', () => {
    render(<SearchPanel />)

    const searchBtn = screen.getByRole('button', { name: /Search/i })
    expect(searchBtn).toBeDisabled()
  })

  it('does not search for whitespace-only input', () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: '   ' } })
    const form = input.closest('form')
    if (form) fireEvent.submit(form)

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('does not crash on search error', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'fail')

    // Wait for the rejected promise to settle — component should not crash
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledOnce()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to search')
    })

    // No results shown
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
  })

  it('has a search landmark', () => {
    render(<SearchPanel />)

    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('navigates to parent page when clicking a result with parent_id', async () => {
    const user = userEvent.setup()

    // search_blocks returns a block with parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'child content',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child content'))).toBeInTheDocument()
    })

    // Mock get_block for parent lookup
    mockedInvoke.mockResolvedValueOnce({
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page Title',
      parent_id: null,
      position: 0,
      deleted_at: null,
      is_conflict: false,
    })

    await user.click(screen.getByText(textContent('child content')))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'PARENT1' })
    })

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(navState.pageStack[0]?.pageId).toBe('PARENT1')
    expect(navState.pageStack[0]?.title).toBe('Parent Page Title')
    expect(navState.selectedBlockId).toBe('CHILD1')
  })

  it('navigates directly when clicking a page-type result', async () => {
    const user = userEvent.setup()

    // search_blocks returns a page block
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'PAGE1',
          parent_id: null,
          content: 'My Page',
          block_type: 'page',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'page')

    await waitFor(() => {
      expect(screen.getByText(textContent('My Page'))).toBeInTheDocument()
    })

    await user.click(screen.getByText(textContent('My Page')))

    await waitFor(() => {
      const navState = useNavigationStore.getState()
      expect(navState.currentView).toBe('page-editor')
      expect(navState.pageStack[0]?.pageId).toBe('PAGE1')
      expect(navState.pageStack[0]?.title).toBe('My Page')
      expect(navState.selectedBlockId).toBeNull()
    })
  })

  it('does not navigate when clicking a root block with no parent', async () => {
    const user = userEvent.setup()

    // search_blocks returns a root block with no parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'ROOT1',
          parent_id: null,
          content: 'root block',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'root')

    await waitFor(() => {
      expect(screen.getByText(textContent('root block'))).toBeInTheDocument()
    })

    await user.click(screen.getByText(textContent('root block')))

    // Navigation should not have changed
    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('search')
    expect(navState.pageStack).toHaveLength(0)
  })

  it('shows toast when parent lookup fails on result click', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'child block',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child block'))).toBeInTheDocument()
    })

    mockedInvoke.mockRejectedValueOnce(new Error('fail'))

    await user.click(screen.getByText(textContent('child block')))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load search results')
    })
  })

  // =========================================================================
  // REVIEW-LATER #58: Edge-case tests for SearchPanel
  // =========================================================================

  it('does not invoke search for explicitly empty query on submit', async () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, '')

    expect(mockedInvoke).not.toHaveBeenCalled()
    // Should not show "No results found." since no search was performed
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
  })

  it('handles very long search query (>500 chars)', async () => {
    const longQuery = 'a'.repeat(501)
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, longQuery)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: longQuery,
        parentId: null,
        tagIds: null,
        cursor: null,
        limit: 50,
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/No results found/)).toBeInTheDocument()
    })
  })

  it('handles special characters in search query', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, '<script>alert("xss")</script>')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: '<script>alert("xss")</script>',
        parentId: null,
        tagIds: null,
        cursor: null,
        limit: 50,
      })
    })

    // Component should not crash — verify it's still mounted
    expect(screen.getByPlaceholderText('Search blocks...')).toBeInTheDocument()
  })

  it('debounces rapid-fire typing and only fires for the final value', async () => {
    vi.useFakeTimers()

    mockedInvoke.mockResolvedValue({
      items: [makeSearchResult({ content: 'final result' })],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')

    // Rapid-fire typing: each change restarts the debounce
    fireEvent.change(input, { target: { value: 'h' } })
    fireEvent.change(input, { target: { value: 'he' } })
    fireEvent.change(input, { target: { value: 'hel' } })
    fireEvent.change(input, { target: { value: 'hell' } })
    fireEvent.change(input, { target: { value: 'hello' } })

    // Before debounce fires: no calls
    expect(mockedInvoke).not.toHaveBeenCalled()

    // Advance past the 300ms debounce
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    // Only one call with the final value
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'hello',
      parentId: null,
      tagIds: null,
      cursor: null,
      limit: 50,
    })
  })

  it('pagination: clicking Load more appends results and hides button when exhausted', async () => {
    const user = userEvent.setup()

    const page1 = {
      items: [makeSearchResult({ id: 'P1', content: 'page one result' })],
      next_cursor: 'cursor_1',
      has_more: true,
    }
    const page2 = {
      items: [makeSearchResult({ id: 'P2', content: 'page two result' })],
      next_cursor: 'cursor_2',
      has_more: true,
    }
    const page3 = {
      items: [makeSearchResult({ id: 'P3', content: 'page three result' })],
      next_cursor: null,
      has_more: false,
    }

    mockedInvoke
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'page')

    // Wait for first page
    await waitFor(() => {
      expect(screen.getByText(textContent('page one result'))).toBeInTheDocument()
    })

    // Load more (page 2)
    let loadMoreBtn = screen.getByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(screen.getByText(textContent('page two result'))).toBeInTheDocument()
    })

    // Load more (page 3 — last page)
    loadMoreBtn = screen.getByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(screen.getByText(textContent('page three result'))).toBeInTheDocument()
    })

    // All three results visible, Load more button gone
    expect(screen.getByText(textContent('page one result'))).toBeInTheDocument()
    expect(screen.getByText(textContent('page two result'))).toBeInTheDocument()
    expect(screen.getByText(textContent('page three result'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('shows spinner during loading state (not just typing)', () => {
    // Never resolve to keep loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'loading')

    // Spinner should be visible because loading is true (form submit sets loading immediately)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('disables result button during click loading', async () => {
    const user = userEvent.setup()

    // search_blocks returns a block with parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'child block',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child block'))).toBeInTheDocument()
    })

    // Mock get_block with a pending promise so loading state persists
    let resolveGetBlock!: (value: unknown) => void
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGetBlock = resolve
        }),
    )

    // biome-ignore lint/style/noNonNullAssertion: test assertion — button always exists in rendered output
    const resultBtn = screen.getByText(textContent('child block')).closest('button')!
    await user.click(resultBtn)

    // Button should be disabled while loading
    await waitFor(() => {
      expect(resultBtn).toBeDisabled()
    })

    // Resolve the pending get_block call
    resolveGetBlock({
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page',
      parent_id: null,
      position: 0,
      deleted_at: null,
      is_conflict: false,
    })

    // Button should re-enable after loading completes
    await waitFor(() => {
      expect(resultBtn).not.toBeDisabled()
    })
  })

  it('search input is auto-focused on mount', () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('Search blocks...')
    expect(input).toHaveFocus()
  })

  it('shows minimum character hint for short queries', () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: 'ab' } })
    expect(screen.getByText('Search requires at least 3 characters')).toBeInTheDocument()
  })

  it('results container has role=listbox', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Recent pages tests (F-6)
  // =========================================================================

  it('shows recent pages when query is empty and localStorage has entries', () => {
    localStorage.setItem(
      'recent_pages',
      JSON.stringify([
        { id: 'P1', title: 'Page One', visitedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'P2', title: 'Page Two', visitedAt: '2024-01-01T00:00:00.000Z' },
      ]),
    )

    render(<SearchPanel />)

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText('Page One')).toBeInTheDocument()
    expect(screen.getByText('Page Two')).toBeInTheDocument()
  })

  it('does not show recent section when localStorage is empty', () => {
    render(<SearchPanel />)

    expect(screen.queryByText('Recent')).not.toBeInTheDocument()
  })

  it('hides recent section when user types a query', () => {
    localStorage.setItem(
      'recent_pages',
      JSON.stringify([{ id: 'P1', title: 'Page One', visitedAt: '2024-01-01T00:00:00.000Z' }]),
    )

    render(<SearchPanel />)
    expect(screen.getByText('Recent')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('Search blocks...')
    fireEvent.change(input, { target: { value: 'search' } })

    expect(screen.queryByText('Recent')).not.toBeInTheDocument()
  })

  it('navigates to page when clicking a recent item', async () => {
    const user = userEvent.setup()

    localStorage.setItem(
      'recent_pages',
      JSON.stringify([{ id: 'P1', title: 'Page One', visitedAt: '2024-01-01T00:00:00.000Z' }]),
    )

    render(<SearchPanel />)
    await user.click(screen.getByText('Page One'))

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(navState.pageStack[0]?.pageId).toBe('P1')
    expect(navState.pageStack[0]?.title).toBe('Page One')
  })

  it('updates recent pages in localStorage when clicking a search result (page type)', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'PAGE1',
          parent_id: null,
          content: 'My Page',
          block_type: 'page',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'page')

    await waitFor(() => {
      expect(screen.getByText(textContent('My Page'))).toBeInTheDocument()
    })

    await user.click(screen.getByText(textContent('My Page')))

    const stored = JSON.parse(localStorage.getItem('recent_pages') ?? '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe('PAGE1')
    expect(stored[0].title).toBe('My Page')
  })

  it('updates recent pages in localStorage when clicking a search result (child block)', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'child content',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child content'))).toBeInTheDocument()
    })

    mockedInvoke.mockResolvedValueOnce({
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page Title',
      parent_id: null,
      position: 0,
      deleted_at: null,
      is_conflict: false,
    })

    await user.click(screen.getByText(textContent('child content')))

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('recent_pages') ?? '[]')
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe('PARENT1')
      expect(stored[0].title).toBe('Parent Page Title')
    })
  })

  it('moves existing page to top of recent list on re-visit', async () => {
    const user = userEvent.setup()

    localStorage.setItem(
      'recent_pages',
      JSON.stringify([
        { id: 'P1', title: 'First', visitedAt: '2024-01-01T00:00:00.000Z' },
        { id: 'P2', title: 'Second', visitedAt: '2024-01-01T00:00:00.000Z' },
      ]),
    )

    render(<SearchPanel />)
    await user.click(screen.getByText('Second'))

    const stored = JSON.parse(localStorage.getItem('recent_pages') ?? '[]')
    expect(stored[0].id).toBe('P2')
    expect(stored[1].id).toBe('P1')
  })

  it('caps recent pages at 10 entries', () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      id: `P${i}`,
      title: `Page ${i}`,
      visitedAt: '2024-01-01T00:00:00.000Z',
    }))
    localStorage.setItem('recent_pages', JSON.stringify(pages))

    addRecentPage('NEW1', 'New Page')

    const stored = JSON.parse(localStorage.getItem('recent_pages') ?? '[]')
    expect(stored).toHaveLength(10)
    expect(stored[0].id).toBe('NEW1')
  })

  // --- PageLink breadcrumb navigation ---
  it('shows visible result count after search', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult(), makeSearchResult({ id: 'B2', content: 'second result' })],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText('2 results found')).toBeInTheDocument()
    })

    // The result count should be visible (not sr-only)
    const countSpan = screen.getByText('2 results found')
    expect(countSpan).not.toHaveClass('sr-only')
    expect(countSpan).toHaveClass('text-xs')
  })

  it('renders search results with rich content (no mark highlight)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult({ content: 'the test content here' })],
      next_cursor: null,
      has_more: false,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText(textContent('the test content here'))).toBeInTheDocument()
    })

    // Rich content rendering replaces HighlightMatch; <mark> is no longer used
    const mark = document.querySelector('mark')
    expect(mark).not.toBeInTheDocument()
  })

  it('clicking page title in breadcrumb navigates to the page', async () => {
    const user = userEvent.setup()

    // search_blocks returns a block with parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          content: 'child with breadcrumb',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
    })
    // batch_resolve returns the parent page title
    mockedInvoke.mockResolvedValueOnce([
      { id: 'PARENT1', title: 'Breadcrumb Page', block_type: 'page', deleted: false },
    ])

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'child')

    // Wait for the breadcrumb to appear
    const pageLink = await screen.findByRole('link', { name: 'Breadcrumb Page' })
    await user.click(pageLink)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(navState.pageStack).toHaveLength(1)
    expect(navState.pageStack[0]?.pageId).toBe('PARENT1')
    expect(navState.pageStack[0]?.title).toBe('Breadcrumb Page')
  })

  // =========================================================================
  // Keyboard navigation tests
  // =========================================================================

  describe('keyboard navigation', () => {
    it('supports ArrowDown/ArrowUp through results', async () => {
      const user = userEvent.setup()

      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'result1' }),
          makeSearchResult({ id: 'B2', content: 'result2' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText('Search blocks...')
      typeAndSubmit(input, 'test')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      const options = screen.getAllByRole('option')

      // Initial state: focusedIndex=0, first item selected
      expect(options[0]).toHaveAttribute('aria-selected', 'true')
      expect(options[1]).toHaveAttribute('aria-selected', 'false')

      // Press ArrowDown — second item should be focused (0→1)
      await user.keyboard('{ArrowDown}')

      expect(options[0]).toHaveAttribute('aria-selected', 'false')
      expect(options[1]).toHaveAttribute('aria-selected', 'true')

      // Press ArrowUp — first item should be focused again (1→0)
      await user.keyboard('{ArrowUp}')

      expect(options[0]).toHaveAttribute('aria-selected', 'true')
      expect(options[1]).toHaveAttribute('aria-selected', 'false')
    })

    it('navigates to result on Enter key', async () => {
      const user = userEvent.setup()

      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'B1',
            content: 'enter result',
            parent_id: 'PARENT1',
            block_type: 'content',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText('Search blocks...')
      typeAndSubmit(input, 'enter')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

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

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // ArrowDown to select first item, then Enter to navigate
      await user.keyboard('{ArrowDown}')
      await user.keyboard('{Enter}')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'PARENT1' })
      })

      await waitFor(() => {
        const navState = useNavigationStore.getState()
        expect(navState.currentView).toBe('page-editor')
        expect(navState.pageStack[0]?.pageId).toBe('PARENT1')
      })
    })

    it('highlights focused result visually', async () => {
      const user = userEvent.setup()

      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'highlight result' }),
          makeSearchResult({ id: 'B2', content: 'other result' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText('Search blocks...')
      typeAndSubmit(input, 'highlight')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const options = screen.getAllByRole('option')

      // Initial state: focusedIndex=0, first item has bg-accent
      expect(options[0]).toHaveClass('bg-accent')
      expect(options[1]).not.toHaveClass('bg-accent')

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // Press ArrowDown — second item should get bg-accent (0→1)
      await user.keyboard('{ArrowDown}')

      expect(options[0]).not.toHaveClass('bg-accent')
      expect(options[1]).toHaveClass('bg-accent')
    })
  })

  // =========================================================================
  // Filter chip bar tests (F-21)
  // =========================================================================

  describe('filter chip bar', () => {
    it('renders filter chip bar with + Page and + Tag buttons', () => {
      render(<SearchPanel />)

      expect(screen.getByTestId('filter-chip-bar')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+ Page' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+ Tag' })).toBeInTheDocument()
    })

    it('shows "in: Page Name" chip after selecting a page filter', async () => {
      const user = userEvent.setup()

      // Mock list_blocks to return pages for the page picker
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'PAGE1',
            block_type: 'page',
            content: 'My Notes',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      // Click "+ Page" to open the page picker popover
      await user.click(screen.getByRole('button', { name: '+ Page' }))

      // Wait for pages to load and click the page
      await waitFor(() => {
        expect(screen.getByText('My Notes')).toBeInTheDocument()
      })

      await user.click(screen.getByText('My Notes'))

      // Should show the page filter chip
      await waitFor(() => {
        expect(screen.getByText('in: My Notes')).toBeInTheDocument()
      })
    })

    it('shows "#tagName" chip after selecting a tag filter', async () => {
      const user = userEvent.setup()

      // Mock list_tags_by_prefix for tag picker
      mockedInvoke.mockResolvedValueOnce([
        { tag_id: 'TAG1', name: 'important', usage_count: 5, updated_at: '2024-01-01' },
        { tag_id: 'TAG2', name: 'urgent', usage_count: 3, updated_at: '2024-01-01' },
      ])

      render(<SearchPanel />)

      // Click "+ Tag" to open the tag picker popover
      await user.click(screen.getByRole('button', { name: '+ Tag' }))

      // Wait for tags to load
      await waitFor(() => {
        expect(screen.getByText('#important')).toBeInTheDocument()
      })

      await user.click(screen.getByText('#important'))

      // Should show the tag filter chip
      await waitFor(() => {
        expect(screen.getByText('#important')).toBeInTheDocument()
      })
    })

    it('removes page chip when clicking X', async () => {
      const user = userEvent.setup()

      // Mock list_blocks for page picker
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'PAGE1',
            block_type: 'page',
            content: 'Test Page',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      // Add a page filter
      await user.click(screen.getByRole('button', { name: '+ Page' }))
      await waitFor(() => {
        expect(screen.getByText('Test Page')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Test Page'))

      await waitFor(() => {
        expect(screen.getByText('in: Test Page')).toBeInTheDocument()
      })

      // Remove the page filter
      await user.click(screen.getByRole('button', { name: 'Remove page filter' }))

      await waitFor(() => {
        expect(screen.queryByText('in: Test Page')).not.toBeInTheDocument()
      })
    })

    it('removes tag chip when clicking X', async () => {
      const user = userEvent.setup()

      // Mock list_tags_by_prefix for tag picker
      mockedInvoke.mockResolvedValueOnce([
        { tag_id: 'TAG1', name: 'work', usage_count: 5, updated_at: '2024-01-01' },
      ])

      render(<SearchPanel />)

      // Add a tag filter
      await user.click(screen.getByRole('button', { name: '+ Tag' }))
      await waitFor(() => {
        expect(screen.getByText('#work')).toBeInTheDocument()
      })
      await user.click(screen.getByText('#work'))

      await waitFor(() => {
        expect(screen.getByText('#work')).toBeInTheDocument()
      })

      // Remove the tag filter
      await user.click(screen.getByRole('button', { name: 'Remove tag work' }))

      await waitFor(() => {
        expect(screen.queryByText('#work')).not.toBeInTheDocument()
      })
    })

    it('shows and uses Clear all to remove all filters', async () => {
      const user = userEvent.setup()

      // Mock list_blocks for page picker
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'PAGE1',
            block_type: 'page',
            content: 'My Page',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      // Clear all should not be visible initially
      expect(screen.queryByText('Clear all')).not.toBeInTheDocument()

      // Add a page filter
      await user.click(screen.getByRole('button', { name: '+ Page' }))
      await waitFor(() => {
        expect(screen.getByText('My Page')).toBeInTheDocument()
      })
      await user.click(screen.getByText('My Page'))

      await waitFor(() => {
        expect(screen.getByText('in: My Page')).toBeInTheDocument()
      })

      // Clear all should be visible now
      expect(screen.getByText('Clear all')).toBeInTheDocument()

      // Click Clear all
      await user.click(screen.getByText('Clear all'))

      // All chips removed
      await waitFor(() => {
        expect(screen.queryByText('in: My Page')).not.toBeInTheDocument()
        expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
      })
    })

    it('passes filters to searchBlocks invoke', async () => {
      const user = userEvent.setup()

      // Mock list_blocks for page picker
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'PAGE1',
            block_type: 'page',
            content: 'Filtered Page',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<SearchPanel />)

      // Add a page filter
      await user.click(screen.getByRole('button', { name: '+ Page' }))
      await waitFor(() => {
        expect(screen.getByText('Filtered Page')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Filtered Page'))

      await waitFor(() => {
        expect(screen.getByText('in: Filtered Page')).toBeInTheDocument()
      })

      // Mock search_blocks response
      mockedInvoke.mockResolvedValueOnce({
        items: [makeSearchResult({ content: 'filtered result' })],
        next_cursor: null,
        has_more: false,
      })

      // Search with filter active
      const input = screen.getByPlaceholderText('Search blocks...')
      typeAndSubmit(input, 'test')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
          query: 'test',
          parentId: 'PAGE1',
          tagIds: null,
          cursor: null,
          limit: 50,
        })
      })
    })

    it('has no a11y violations with filters active', async () => {
      const user = userEvent.setup()

      // Mock list_blocks for page picker
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({
            id: 'PAGE1',
            block_type: 'page',
            content: 'A11y Page',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<SearchPanel />)

      // Add a page filter
      await user.click(screen.getByRole('button', { name: '+ Page' }))
      await waitFor(() => {
        expect(screen.getByText('A11y Page')).toBeInTheDocument()
      })
      await user.click(screen.getByText('A11y Page'))

      await waitFor(() => {
        expect(screen.getByText('in: A11y Page')).toBeInTheDocument()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
