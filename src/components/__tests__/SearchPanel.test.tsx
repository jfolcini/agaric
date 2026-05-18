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
import { t } from '@/lib/i18n'
import { addRecentPage } from '../../lib/recent-pages'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { selectPageStack, useTabsStore } from '../../stores/tabs'
import { SearchPanel } from '../SearchPanel'

// UX-153: Mock resolvePageByAlias separately so alias-resolution calls
// don't consume values from the FIFO invoke mock queue.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    resolvePageByAlias: vi.fn().mockResolvedValue(null),
  }
})

import { resolvePageByAlias } from '../../lib/tauri'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

const makeSearchResult = (overrides?: Partial<Record<string, unknown>>) => ({
  id: 'BLOCK1',
  block_type: 'content',
  content: 'test content',
  parent_id: null,
  page_id: null,
  position: 1,
  deleted_at: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // Re-establish default after clearAllMocks resets it
  vi.mocked(resolvePageByAlias).mockResolvedValue(null)
  useNavigationStore.setState({
    currentView: 'search',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  // FEAT-3 Phase 2 — SearchPanel now gates on `useSpaceStore.isReady`
  // and passes `currentSpaceId` to `searchBlocks`. Seed the store so
  // tests exercise the real code path (not the loading skeleton).
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
    ],
    isReady: true,
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
    expect(screen.getByPlaceholderText(t('search.searchPlaceholder'))).toBeInTheDocument()
  })

  // UX-338 — placeholder must mention the 3-character minimum so users see
  // the requirement before they type, not only after.
  it('placeholder mentions the 3-character minimum', () => {
    render(<SearchPanel />)
    const input = screen.getByLabelText(t('search.searchLabel')) as HTMLInputElement
    expect(input.placeholder).toMatch(/3\+\s*chars/i)
  })

  it('shows no results before first search', () => {
    render(<SearchPanel />)
    expect(screen.queryByText(t('search.noResultsFound'))).not.toBeInTheDocument()
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument()
  })

  it('searches via form submit', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'test',
        cursor: null,
        limit: 50,
        filter: {
          parentId: null,
          tagIds: [],
          spaceId: 'SPACE_TEST',
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: 'query' } })

    const searchBtn = screen.getByRole('button', { name: /Search/i })
    await user.click(searchBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'query',
        cursor: null,
        limit: 50,
        filter: {
          parentId: null,
          tagIds: [],
          spaceId: 'SPACE_TEST',
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('button result')).toBeInTheDocument()
    })
  })

  it('shows "No results found." for empty results', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'nothing')

    await waitFor(() => {
      expect(screen.getByText(t('search.noResultsFound'))).toBeInTheDocument()
    })
  })

  it('shows skeleton loaders while loading', () => {
    // Never resolve to keep loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
      total_count: null,
    }
    const page2 = {
      items: [makeSearchResult({ id: 'B2', content: 'second result' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'result')

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: 'result',
        cursor: 'cursor_abc',
        limit: 50,
        filter: {
          parentId: null,
          tagIds: [],
          spaceId: 'SPACE_TEST',
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: 'debounce' } })

    // Not yet called — debounce timer hasn't fired
    expect(mockedInvoke).not.toHaveBeenCalled()

    // Advance past the 300ms debounce and flush promises
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
      query: 'debounce',
      cursor: null,
      limit: 50,
      filter: {
        parentId: null,
        tagIds: [],
        spaceId: 'SPACE_TEST',
        includePageGlobs: [],
        excludePageGlobs: [],
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    })
  })

  it('clears results when input cleared', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText(textContent('test content'))).toBeInTheDocument()
    })

    // Clear the input — triggers onChange with empty value, which resets results
    fireEvent.change(input, { target: { value: '' } })

    await waitFor(() => {
      expect(screen.queryByText(textContent('test content'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('search.noResultsFound'))).not.toBeInTheDocument()
    })
  })

  // UX-246: SearchInput clear (✕) button appears when the field has content
  // and clearing it resets the input value (and in turn the results).
  it('shows clear button when typing and resets on click', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { container } = render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder')) as HTMLInputElement

    // Clear button is absent while the field is empty
    expect(container.querySelector('[data-testid="search-input-clear"]')).toBeNull()

    // Type without submitting: the clear button appears as soon as value is non-empty
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(input.value).toBe('hello')

    const clearButton = container.querySelector(
      '[data-testid="search-input-clear"]',
    ) as HTMLButtonElement | null
    expect(clearButton).not.toBeNull()

    // a11y: the input + clear-button combination has no violations (pre-results state)
    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()

    // Now submit to populate results, then click the clear button
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText(textContent('test content'))).toBeInTheDocument()
    })

    const clearButtonAfterSearch = container.querySelector(
      '[data-testid="search-input-clear"]',
    ) as HTMLButtonElement | null
    expect(clearButtonAfterSearch).not.toBeNull()

    await user.click(clearButtonAfterSearch as HTMLButtonElement)

    // Query + results reset, clear button disappears
    await waitFor(() => {
      expect(input.value).toBe('')
      expect(screen.queryByText(textContent('test content'))).not.toBeInTheDocument()
      expect(container.querySelector('[data-testid="search-input-clear"]')).toBeNull()
    })
  })

  it('shows CJK notice for CJK input', () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: '你好' } })

    expect(screen.getByText(t('search.cjkLimitationNote'))).toBeInTheDocument()
    // UX-336 — notice surfaces the 3-character minimum workaround so CJK
    // users know how to widen matches.
    const notice = screen.getByTestId('cjk-notice')
    expect(notice.textContent).toMatch(/3/)
  })

  it('does not show CJK notice for Latin input', () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: 'hello' } })

    expect(screen.queryByText(t('search.cjkLimitationNote'))).not.toBeInTheDocument()
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

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: '   ' } })
    const form = input.closest('form')
    if (form) fireEvent.submit(form)

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('does not crash on search error', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'fail')

    // Wait for the rejected promise to settle — component should not crash
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledOnce()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('search.failed'))
    })

    // No results shown
    expect(screen.queryByText(t('search.noResultsFound'))).not.toBeInTheDocument()
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
          page_id: 'PARENT1',
          content: 'child content',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
    })

    await user.click(screen.getByText(textContent('child content')))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'PARENT1' })
    })

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('PARENT1')
    expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('Parent Page Title')
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'page')

    // PEND-50 Phase 1 — a page-type hit now appears twice in the
    // grouped layout: once as the page-link group header (clickable)
    // and once as the `role="option"` row body. Click the row itself
    // (the option, which is now a click-handling `<li>`) so we
    // exercise `handleResultClick`; the header path is exercised by
    // the breadcrumb test.
    const option = await screen.findByRole('option')
    await user.click(option)

    await waitFor(() => {
      const navState = useNavigationStore.getState()
      expect(navState.currentView).toBe('page-editor')
      expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('PAGE1')
      expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('My Page')
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'root')

    await waitFor(() => {
      expect(screen.getByText(textContent('root block'))).toBeInTheDocument()
    })

    await user.click(screen.getByText(textContent('root block')))

    // Navigation should not have changed
    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('search')
    expect(selectPageStack(useTabsStore.getState())).toHaveLength(0)
  })

  it('shows toast when parent lookup fails on result click', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          page_id: 'PARENT1',
          content: 'child block',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child block'))).toBeInTheDocument()
    })

    mockedInvoke.mockRejectedValueOnce(new Error('fail'))

    await user.click(screen.getByText(textContent('child block')))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('search.loadResultsFailed'))
    })
  })

  // =========================================================================
  // REVIEW-LATER #58: Edge-case tests for SearchPanel
  // =========================================================================

  it('does not invoke search for explicitly empty query on submit', async () => {
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, '')

    expect(mockedInvoke).not.toHaveBeenCalled()
    // Should not show "No results found." since no search was performed
    expect(screen.queryByText(t('search.noResultsFound'))).not.toBeInTheDocument()
  })

  it('handles very long search query (>500 chars)', async () => {
    const longQuery = 'a'.repeat(501)
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, longQuery)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: longQuery,
        cursor: null,
        limit: 50,
        filter: {
          parentId: null,
          tagIds: [],
          spaceId: 'SPACE_TEST',
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText(t('search.noResultsFound'))).toBeInTheDocument()
    })
  })

  it('handles special characters in search query', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, '<script>alert("xss")</script>')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('search_blocks', {
        query: '<script>alert("xss")</script>',
        cursor: null,
        limit: 50,
        filter: {
          parentId: null,
          tagIds: [],
          spaceId: 'SPACE_TEST',
          includePageGlobs: [],
          excludePageGlobs: [],
          caseSensitive: false,
          wholeWord: false,
          isRegex: false,
        },
      })
    })

    // Component should not crash — verify it's still mounted
    expect(screen.getByPlaceholderText(t('search.searchPlaceholder'))).toBeInTheDocument()
  })

  it('debounces rapid-fire typing and only fires for the final value', async () => {
    vi.useFakeTimers()

    mockedInvoke.mockResolvedValue({
      items: [makeSearchResult({ content: 'final result' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))

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
      cursor: null,
      limit: 50,
      filter: {
        parentId: null,
        tagIds: [],
        spaceId: 'SPACE_TEST',
        includePageGlobs: [],
        excludePageGlobs: [],
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      },
    })
  })

  it('pagination: clicking Load more appends results and hides button when exhausted', async () => {
    const user = userEvent.setup()

    const page1 = {
      items: [makeSearchResult({ id: 'P1', content: 'page one result' })],
      next_cursor: 'cursor_1',
      has_more: true,
      total_count: null,
    }
    const page2 = {
      items: [makeSearchResult({ id: 'P2', content: 'page two result' })],
      next_cursor: 'cursor_2',
      has_more: true,
      total_count: null,
    }
    const page3 = {
      items: [makeSearchResult({ id: 'P3', content: 'page three result' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }

    mockedInvoke
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3)

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'loading')

    // Spinner should be visible because loading is true (form submit sets loading immediately)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('disables result row during click loading', async () => {
    const user = userEvent.setup()

    // search_blocks returns a block with parent_id
    mockedInvoke.mockResolvedValueOnce({
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          page_id: 'PARENT1',
          content: 'child block',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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

    // PEND-50 Phase 1 — the row is a `role="option"` `<li>` (not a
    // `<button>`); "disabled" surfaces via `aria-disabled` rather than
    // the disabled DOM property.
    const resultRow = screen.getByRole('option')
    await user.click(resultRow)

    await waitFor(() => {
      expect(resultRow).toHaveAttribute('aria-disabled', 'true')
    })

    // Resolve the pending get_block call
    resolveGetBlock({
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page',
      parent_id: null,
      position: 0,
      deleted_at: null,
    })

    await waitFor(() => {
      expect(resultRow).not.toHaveAttribute('aria-disabled', 'true')
    })
  })

  it('search input is auto-focused on mount', () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    expect(input).toHaveFocus()
  })

  it('shows minimum character hint for short queries', () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: 'ab' } })
    expect(screen.getByText(t('search.minCharsHint'))).toBeInTheDocument()
  })

  it('results container has role=listbox', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  // PEND-50 Phase 1 — the flat listbox was replaced with per-group
  // listboxes (one per page), wrapped in a `role="region"` with the
  // localised label. The per-group listbox `aria-label` resolves via
  // `t('search.groupExpandedLabel', { pageTitle: ... })`. We assert
  // both surfaces here to lock in the a11y model rather than the old
  // single-listbox label.
  it('results region + per-group listbox aria-labels resolve via t() (UX-210 / PEND-50)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult()],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: t('search.resultsRegionLabel') }),
      ).toBeInTheDocument()
    })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
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

    expect(screen.getByText(t('search.recentTitle'))).toBeInTheDocument()
    expect(screen.getByText('Page One')).toBeInTheDocument()
    expect(screen.getByText('Page Two')).toBeInTheDocument()
  })

  it('does not show recent section when localStorage is empty', () => {
    render(<SearchPanel />)

    expect(screen.queryByText(t('search.recentTitle'))).not.toBeInTheDocument()
  })

  it('hides recent section when user types a query', () => {
    localStorage.setItem(
      'recent_pages',
      JSON.stringify([{ id: 'P1', title: 'Page One', visitedAt: '2024-01-01T00:00:00.000Z' }]),
    )

    render(<SearchPanel />)
    expect(screen.getByText(t('search.recentTitle'))).toBeInTheDocument()

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.change(input, { target: { value: 'search' } })

    expect(screen.queryByText(t('search.recentTitle'))).not.toBeInTheDocument()
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
    expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('P1')
    expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('Page One')
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'page')

    // PEND-50 Phase 1 — click the row itself (the option, a
    // click-handling `<li>`), not the page-link header, so we
    // exercise `handleResultClick` and its recent-page bookkeeping.
    const option = await screen.findByRole('option')
    await user.click(option)

    const stored = JSON.parse(localStorage.getItem('recent_pages') ?? '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe('PAGE1')
    expect(stored[0].title).toBe('My Page')
  })

  it('updates recent pages in localStorage when clicking a search result (child block)', async () => {
    const user = userEvent.setup()

    // Dispatch by command name rather than queue-order. SearchPanel's
    // useEffect at `src/components/SearchPanel.tsx:170` fires
    // `batchResolve(parentIds)` for breadcrumb resolution after results
    // render, and the click handler then fires `get_block` for the
    // parent fetch. Order between those two invokes is microtask-
    // dependent, so a `mockResolvedValueOnce` queue races with vitest
    // worker concurrency and flakes under cross-file runs (observed
    // during prek's vitest hook even though the test passes in
    // isolation). Mirrors the alias-match test at line 1874+.
    const searchResults = {
      items: [
        makeSearchResult({
          id: 'CHILD1',
          parent_id: 'PARENT1',
          page_id: 'PARENT1',
          content: 'child content',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    const parentBlock = {
      id: 'PARENT1',
      block_type: 'page',
      content: 'Parent Page Title',
      parent_id: null,
      position: 0,
      deleted_at: null,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') return searchResults
      if (cmd === 'get_block') return parentBlock
      if (cmd === 'batch_resolve') return []
      return emptyPage
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'child')

    await waitFor(() => {
      expect(screen.getByText(textContent('child content'))).toBeInTheDocument()
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
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(screen.getByText(t('search.resultsCount', { count: 2 }))).toBeInTheDocument()
    })

    // The result count should be visible (not sr-only)
    const countSpan = screen.getByText(t('search.resultsCount', { count: 2 }))
    expect(countSpan).not.toHaveClass('sr-only')
    expect(countSpan).toHaveClass('text-xs')
  })

  it('renders search results with rich content (no mark highlight)', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makeSearchResult({ content: 'the test content here' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
          page_id: 'PARENT1',
          content: 'child with breadcrumb',
          block_type: 'content',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    // batch_resolve returns the parent page title
    mockedInvoke.mockResolvedValueOnce([
      { id: 'PARENT1', title: 'Breadcrumb Page', block_type: 'page', deleted: false },
    ])

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'child')

    // Wait for the breadcrumb to appear
    const pageLink = await screen.findByRole('link', { name: 'Breadcrumb Page' })
    await user.click(pageLink)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
    expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('PARENT1')
    expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('Breadcrumb Page')
  })

  // FE-H-20: SearchPanel must dedupe parentIds before invoking
  // batchResolve, mirroring the pattern in TagFilterPanel.tsx:137. Without
  // the `[...new Set(...)]` wrap, a results page with N children of the
  // same parent page would resolve the parent N times.
  it('dedupes parent page_ids before calling batchResolve', async () => {
    // 5 blocks share 3 distinct page_ids: PAGE_A x3, PAGE_B x1, PAGE_C x1.
    const searchResults = {
      items: [
        makeSearchResult({ id: 'B1', page_id: 'PAGE_A', content: 'one' }),
        makeSearchResult({ id: 'B2', page_id: 'PAGE_A', content: 'two' }),
        makeSearchResult({ id: 'B3', page_id: 'PAGE_A', content: 'three' }),
        makeSearchResult({ id: 'B4', page_id: 'PAGE_B', content: 'four' }),
        makeSearchResult({ id: 'B5', page_id: 'PAGE_C', content: 'five' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') return searchResults
      if (cmd === 'batch_resolve') return []
      return emptyPage
    })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'test')

    await waitFor(() => {
      expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'batch_resolve')).toBe(true)
    })

    const batchResolveCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'batch_resolve')
    expect(batchResolveCalls).toHaveLength(1)
    const args = batchResolveCalls[0]?.[1] as { ids: string[] }
    expect(args.ids).toHaveLength(3)
    expect([...args.ids].sort()).toEqual(['PAGE_A', 'PAGE_B', 'PAGE_C'])
  })

  // =========================================================================
  // Keyboard navigation tests
  // =========================================================================

  describe('keyboard navigation', () => {
    it('supports ArrowDown/ArrowUp through results', async () => {
      const user = userEvent.setup()

      // PEND-50 Phase 1 — results are page-grouped now. Share a
      // `page_id` so both rows land in the same listbox; the
      // keyboard-nav assertion is unchanged.
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'result1', page_id: 'P_NAV' }),
          makeSearchResult({ id: 'B2', content: 'result2', page_id: 'P_NAV' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
            page_id: 'PARENT1',
            block_type: 'content',
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
        expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('PARENT1')
      })
    })

    it('highlights focused result visually', async () => {
      const user = userEvent.setup()

      // PEND-50 Phase 1 — share `page_id` so both rows are in one
      // listbox (page-grouped layout).
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'highlight result', page_id: 'P_HL' }),
          makeSearchResult({ id: 'B2', content: 'other result', page_id: 'P_HL' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
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
  // Home/End and PageUp/PageDown keyboard navigation (UX-138)
  // =========================================================================

  describe('Home/End and PageUp/PageDown navigation', () => {
    it('Home key moves focus to first result, End to last', async () => {
      const user = userEvent.setup()

      // PEND-50 Phase 1 — single page-group so Home/End walk the same
      // listbox (the keyboard hook is per-group; Home/End within one
      // group covers the same behaviour).
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'first', page_id: 'P_HE' }),
          makeSearchResult({ id: 'B2', content: 'second', page_id: 'P_HE' }),
          makeSearchResult({ id: 'B3', content: 'third', page_id: 'P_HE' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'test')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      const options = screen.getAllByRole('option')

      // Move to second item first
      await user.keyboard('{ArrowDown}')
      expect(options[1]).toHaveAttribute('aria-selected', 'true')

      // End key should jump to last result
      await user.keyboard('{End}')
      expect(options[2]).toHaveAttribute('aria-selected', 'true')

      // Home key should jump to first result
      await user.keyboard('{Home}')
      expect(options[0]).toHaveAttribute('aria-selected', 'true')
    })

    it('PageDown/PageUp navigate through results', async () => {
      const user = userEvent.setup()

      // PEND-50 Phase 1 — single page-group so all 15 rows share one
      // listbox.
      const items = Array.from({ length: 15 }, (_, i) =>
        makeSearchResult({ id: `B${i}`, content: `result ${i}`, page_id: 'P_PG' }),
      )

      mockedInvoke.mockResolvedValueOnce({
        items,
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'test')

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      const options = screen.getAllByRole('option')

      // PageDown should jump forward by 10
      await user.keyboard('{PageDown}')
      expect(options[10]).toHaveAttribute('aria-selected', 'true')

      // PageUp should jump back by 10
      await user.keyboard('{PageUp}')
      expect(options[0]).toHaveAttribute('aria-selected', 'true')
    })
  })

  // UX-198: the search form used to live inside a `sticky top-0` wrapper.
  // It's now hoisted to the App-level outlet via <ViewHeader>. The form
  // must still render (via ViewHeader's inline fallback in isolated tests)
  // but the stale sticky classes must be gone from this component's subtree.
  describe('UX-198 header outlet migration', () => {
    it('has no sticky top-0 element and still renders the search form', () => {
      const { container } = render(<SearchPanel />)
      expect(screen.getByPlaceholderText(t('search.searchPlaceholder'))).toBeInTheDocument()
      expect(screen.getByRole('search')).toBeInTheDocument()
      const sticky = container.querySelector('.sticky.top-0')
      expect(sticky).toBeNull()
    })
  })

  // FEAT-3 Phase 2 — scoping + loading gate. SearchPanel now consults
  // `useSpaceStore.isReady` before firing `searchBlocks`, and passes
  // `currentSpaceId` through so the backend filters results to the
  // active space. When the store hasn't hydrated yet the component
  // renders a `LoadingSkeleton` instead of the search form.
  describe('space scoping (FEAT-3 Phase 2)', () => {
    it('renders a loading skeleton when the space store has not hydrated', () => {
      useSpaceStore.setState({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: false,
      })

      const { container } = render(<SearchPanel />)

      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons).toHaveLength(3)
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
      // The search form must NOT render while the skeleton is up —
      // otherwise a quick keystroke would fire `searchBlocks` with a
      // null `spaceId` and leak cross-space matches.
      expect(screen.queryByPlaceholderText(t('search.searchPlaceholder'))).not.toBeInTheDocument()
    })

    it('does not fire searchBlocks while the store is unhydrated', async () => {
      useSpaceStore.setState({
        currentSpaceId: null,
        availableSpaces: [],
        isReady: false,
      })

      render(<SearchPanel />)

      // Tick once so any queued effects have a chance to run.
      await act(async () => {
        await Promise.resolve()
      })

      const searchCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'search_blocks')
      expect(searchCalls).toHaveLength(0)
    })

    it('passes the current spaceId through to searchBlocks after hydration', async () => {
      // The default `beforeEach` already seeded the store with
      // `currentSpaceId: 'SPACE_TEST'` + `isReady: true`, but we set
      // a distinct id here to make the assertion less ambiguous.
      useSpaceStore.setState({
        currentSpaceId: 'SPACE_WORK',
        availableSpaces: [{ id: 'SPACE_WORK', name: 'Work', accent_color: null }],
        isReady: true,
      })
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'scoped')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'search_blocks',
          expect.objectContaining({
            query: 'scoped',
            filter: expect.objectContaining({ spaceId: 'SPACE_WORK' }),
          }),
        )
      })
    })
  })

  // =========================================================================
  // UX-269: SearchPanel consolidation (6 sub-fixes)
  // =========================================================================
  describe('UX-269 consolidation', () => {
    // Sub-fix 1: Switch to shared LoadMoreButton (aria-busy when loading).
    it('uses the shared LoadMoreButton with aria-busy when fetching more', async () => {
      const user = userEvent.setup()

      const page1 = {
        items: [makeSearchResult({ id: 'B1', content: 'first' })],
        next_cursor: 'cursor_1',
        has_more: true,
        total_count: null,
      }
      mockedInvoke.mockResolvedValueOnce(page1)

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'pageload')

      const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })

      // Idle state: aria-busy should be 'false' (LoadMoreButton primitive sets it).
      expect(loadMoreBtn).toHaveAttribute('aria-busy', 'false')

      // Stall the next fetch so the button stays in loading state.
      mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
      await user.click(loadMoreBtn)

      // Loading state: aria-busy must flip to 'true'.
      await waitFor(() => {
        expect(loadMoreBtn).toHaveAttribute('aria-busy', 'true')
      })
      // The shared primitive renders its identifying spinner testid.
      expect(loadMoreBtn.querySelector('[data-testid="loader-spinner"]')).not.toBeNull()
    })

    // Sub-fix 2: aria-live on a separate status div above the listbox,
    // NOT wrapping the listbox.
    it('puts aria-live on a separate status div, not wrapping the listbox', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makeSearchResult({ id: 'B1', content: 'live region result' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'live')

      const listbox = await screen.findByRole('listbox')
      // The listbox itself must not be (or be wrapped by) an aria-live region.
      expect(listbox).not.toHaveAttribute('aria-live')
      expect(listbox.closest('[aria-live]')).toBeNull()

      // A separate status div with aria-live="polite" exists.
      const status = screen.getByTestId('search-results-status')
      expect(status).toHaveAttribute('aria-live', 'polite')
      expect(status).toHaveAttribute('role', 'status')
      // Status must be a sibling of (not contain) the listbox.
      expect(status.contains(listbox)).toBe(false)
    })

    // Sub-fix 3: Distinct typing vs searching indicators.
    it('shows a typing indicator while debouncing and a Searching label while fetching', async () => {
      vi.useFakeTimers()

      // Stall the fetch so we observe the searching state.
      mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

      render(<SearchPanel />)
      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))

      // While debounce is pending → typing indicator, NOT searching.
      fireEvent.change(input, { target: { value: 'hello' } })
      expect(screen.getByTestId('search-typing-indicator')).toBeInTheDocument()
      expect(screen.getByTestId('search-typing-indicator')).toHaveTextContent(t('search.typing'))
      expect(screen.queryByTestId('search-fetching-indicator')).not.toBeInTheDocument()

      // Advance past 300ms debounce → fetching kicks off.
      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      // Now the fetching indicator with Searching label shows; typing is gone.
      const fetching = screen.getByTestId('search-fetching-indicator')
      expect(fetching).toBeInTheDocument()
      expect(fetching).toHaveTextContent(t('search.searching'))
      expect(screen.queryByTestId('search-typing-indicator')).not.toBeInTheDocument()
    })

    // Sub-fix 4: CJK notice sits directly below the search input (above
    // the filter chip bar) so CJK users see it before scanning results.
    it('places the CJK notice directly below the input, above the filter chip bar', () => {
      render(<SearchPanel />)
      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      fireEvent.change(input, { target: { value: '你好' } })

      const cjk = screen.getByTestId('cjk-notice')
      const chipBar = screen.getByTestId('filter-chip-bar')
      expect(cjk).toBeInTheDocument()

      // DOM order: cjk-notice precedes filter-chip-bar.
      const position = cjk.compareDocumentPosition(chipBar)
      // DOCUMENT_POSITION_FOLLOWING (4) means chipBar follows cjk.
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    // Sub-fix 5: Alias-match overlay is rendered inside the ResultCard
    // (via the children slot) and not absolutely positioned.
    it('renders the alias-match label inside the ResultCard, not as an absolute overlay', async () => {
      // The alias-resolution effect re-runs when `results` reference changes
      // after the search completes — use a persistent mock so both calls
      // resolve to the alias hit.
      vi.mocked(resolvePageByAlias).mockResolvedValue(['ALIASPAGE', null])
      const aliasBlock = {
        id: 'ALIASPAGE',
        block_type: 'page',
        content: 'Aliased Page',
        parent_id: null,
        page_id: null,
        position: 0,
        deleted_at: null,
      }
      // search_blocks (empty), then get_block resolves the alias hit on
      // every effect re-run.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'search_blocks') return emptyPage
        if (cmd === 'get_block') return aliasBlock
        if (cmd === 'batch_resolve') return []
        return emptyPage
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'shortname')

      const aliasContainer = await screen.findByTestId('alias-match')
      const aliasLabel = await screen.findByTestId('alias-match-label')

      // Label sits inside the ResultCard's CardButton (not an absolute sibling).
      const card = aliasContainer.querySelector('button')
      expect(card).not.toBeNull()
      expect(card?.contains(aliasLabel)).toBe(true)

      // No absolute positioning class on the alias label or its parent inside the container.
      expect(aliasLabel.className).not.toMatch(/\babsolute\b/)
      expect(aliasContainer.querySelector('.absolute')).toBeNull()
    })

    // Sub-fix 6: Results count is rendered inside an aria-live="polite"
    // status region (the same one from sub-fix 2).
    it('announces the results count via the aria-live status region', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makeSearchResult({ id: 'B1', content: 'one' }),
          makeSearchResult({ id: 'B2', content: 'two' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'count')

      const status = await screen.findByTestId('search-results-status')
      expect(status).toHaveAttribute('aria-live', 'polite')
      expect(status).toHaveAttribute('role', 'status')

      await waitFor(() => {
        expect(status).toHaveTextContent(t('search.resultsCount', { count: 2 }))
      })

      // The visible count node is a child of the status region.
      const count = screen.getByTestId('search-results-count')
      expect(status.contains(count)).toBe(true)
    })
  })

  // =========================================================================
  // UX-335: aria-live region must produce text in zero-result and
  // search-cleared states (not stay empty). Pre-search stays silent.
  // =========================================================================
  describe('UX-335 aria-live status text', () => {
    it('announces "No results" when a search returns zero results', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'nothing-matches')

      const status = await screen.findByTestId('search-results-status')

      await waitFor(() => {
        const count = screen.getByTestId('search-results-count')
        expect(count).toHaveTextContent(t('search.statusNoResults'))
        expect(status.contains(count)).toBe(true)
      })
    })

    it('announces "Search cleared" after clearing a previous search', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makeSearchResult({ id: 'B1', content: 'previous result' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<SearchPanel />)

      const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
      typeAndSubmit(input, 'previous')

      // Wait for the search to complete and the count to be announced.
      await waitFor(() => {
        expect(screen.getByTestId('search-results-count')).toHaveTextContent(
          t('search.resultsCount', { count: 1 }),
        )
      })

      // Clear the input — the live region should flip to "Search cleared".
      fireEvent.change(input, { target: { value: '' } })

      await waitFor(() => {
        const count = screen.getByTestId('search-results-count')
        expect(count).toHaveTextContent(t('search.statusCleared'))
      })

      const status = screen.getByTestId('search-results-status')
      expect(status).toHaveAttribute('aria-live', 'polite')
    })

    it('keeps the live region empty before any search has been performed', () => {
      render(<SearchPanel />)

      const status = screen.getByTestId('search-results-status')
      // No inner count node should be rendered pre-search.
      expect(status.querySelector('[data-testid="search-results-count"]')).toBeNull()
      expect(status).toHaveTextContent('')
    })
  })
})
