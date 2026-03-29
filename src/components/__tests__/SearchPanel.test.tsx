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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { SearchPanel } from '../SearchPanel'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false }

const makeSearchResult = (overrides?: Partial<Record<string, unknown>>) => ({
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

beforeEach(() => {
  vi.clearAllMocks()
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

describe('SearchPanel', () => {
  it('renders search input', () => {
    render(<SearchPanel />)
    expect(screen.getByPlaceholderText('Search blocks...')).toBeInTheDocument()
  })

  it('shows no results before first search', () => {
    render(<SearchPanel />)
    expect(screen.queryByText('No results found.')).not.toBeInTheDocument()
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
        cursor: null,
        limit: 50,
      })
    })

    await waitFor(() => {
      expect(screen.getByText('test content')).toBeInTheDocument()
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
      expect(screen.getByText('No results found.')).toBeInTheDocument()
    })
  })

  it('shows "Searching..." while loading', () => {
    // Never resolve to keep loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText('Search blocks...')
    typeAndSubmit(input, 'slow')

    expect(screen.getByText('Searching...')).toBeInTheDocument()
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
        cursor: 'cursor_abc',
        limit: 50,
      })
    })

    // Both results should be rendered (accumulated)
    await waitFor(() => {
      expect(screen.getByText('first result')).toBeInTheDocument()
      expect(screen.getByText('second result')).toBeInTheDocument()
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
      expect(screen.getByText('test content')).toBeInTheDocument()
    })

    // Clear the input — triggers onChange with empty value, which resets results
    fireEvent.change(input, { target: { value: '' } })

    await waitFor(() => {
      expect(screen.queryByText('test content')).not.toBeInTheDocument()
      expect(screen.queryByText('No results found.')).not.toBeInTheDocument()
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

    // No results shown and no error banner — silent failure
    expect(screen.queryByText('No results found.')).not.toBeInTheDocument()
  })

  it('has a search landmark', () => {
    render(<SearchPanel />)

    expect(screen.getByRole('search')).toBeInTheDocument()
  })
})
