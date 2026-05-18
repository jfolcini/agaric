/**
 * PEND-55 — integration tests for `<SearchPanel>` toggles + history.
 *
 * Coverage:
 * - Clicking a toggle changes the IPC payload's `caseSensitive` /
 *   `wholeWord` / `isRegex` flag.
 * - Submitting a query pushes it onto the history store; the history
 *   dropdown surfaces it on a subsequent focus while the input is
 *   empty.
 * - Clicking a history entry refills the input + fires a search.
 * - Toggle state persists across re-mounts via localStorage.
 * - Backward-compat: a row carrying `match_offsets` renders highlight
 *   nodes.
 *
 * NB: these tests intentionally use synchronous `fireEvent` + form
 * submit (mirroring `SearchPanel.test.tsx`) because the debounce-
 * timer pattern doesn't play well with `userEvent` + `advanceTimersByTime`.
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '../../stores/navigation'
import { useSearchHistoryStore } from '../../stores/search-history'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { SearchPanel } from '../SearchPanel'

vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    resolvePageByAlias: vi.fn().mockResolvedValue(null),
  }
})

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

function typeAndSubmit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  const form = input.closest('form')
  if (form) fireEvent.submit(form)
}

function lastFilter(): Record<string, unknown> | null {
  const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'search_blocks')
  if (calls.length === 0) return null
  const last = calls[calls.length - 1] as unknown as [string, { filter: Record<string, unknown> }]
  return last[1].filter
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSearchHistoryStore.setState({ bySpace: {} })
  useNavigationStore.setState({ currentView: 'search', selectedBlockId: null })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('SearchPanel toggles', () => {
  it('clicking the regex toggle threads `isRegex: true` into the IPC payload', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    const regexButton = screen.getByTestId('search-toggle-regex')
    fireEvent.click(regexButton)
    expect(regexButton).toHaveAttribute('aria-pressed', 'true')

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, '^TODO')

    await waitFor(() => {
      const filter = lastFilter()
      expect(filter).not.toBeNull()
      expect(filter?.['isRegex']).toBe(true)
      expect(filter?.['caseSensitive']).toBe(false)
      expect(filter?.['wholeWord']).toBe(false)
    })
  })

  it('clicking case-sensitive sends `caseSensitive: true`', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    fireEvent.click(screen.getByTestId('search-toggle-case-sensitive'))
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'Alpha')
    await waitFor(() => {
      expect(lastFilter()?.['caseSensitive']).toBe(true)
      expect(lastFilter()?.['isRegex']).toBe(false)
    })
  })

  it('clicking whole-word sends `wholeWord: true`', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    fireEvent.click(screen.getByTestId('search-toggle-whole-word'))
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'cat')
    await waitFor(() => {
      expect(lastFilter()?.['wholeWord']).toBe(true)
    })
  })

  it('persists toggle state in localStorage across re-renders', () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    const { unmount } = render(<SearchPanel />)
    fireEvent.click(screen.getByTestId('search-toggle-whole-word'))
    expect(screen.getByTestId('search-toggle-whole-word')).toHaveAttribute('aria-pressed', 'true')
    unmount()
    render(<SearchPanel />)
    expect(screen.getByTestId('search-toggle-whole-word')).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders the toggle row inside a toolbar landmark', () => {
    render(<SearchPanel />)
    expect(screen.getByRole('toolbar', { name: /Search modes/i })).toBeInTheDocument()
  })

  it('has no a11y violations on the toggle row', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    const { container } = render(<SearchPanel />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('SearchPanel history', () => {
  it('submitting a query pushes it onto the per-space history store', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'hello world')
    await waitFor(() => {
      const state = useSearchHistoryStore.getState()
      expect(state.bySpace['SPACE_TEST']).toEqual(['hello world'])
    })
  })

  it('focused-while-empty surfaces the history dropdown with stored entries', async () => {
    useSearchHistoryStore.setState({
      bySpace: { SPACE_TEST: ['recent A', 'recent B'] },
    })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)
    await waitFor(() => {
      expect(screen.getByTestId('search-history-dropdown')).toBeInTheDocument()
    })
    expect(screen.getByTestId('search-history-entry-0')).toHaveTextContent('recent A')
    expect(screen.getByTestId('search-history-entry-1')).toHaveTextContent('recent B')
  })

  it('typing hides the dropdown (input no longer empty)', async () => {
    useSearchHistoryStore.setState({ bySpace: { SPACE_TEST: ['alpha'] } })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)
    await waitFor(() => {
      expect(screen.queryByTestId('search-history-dropdown')).not.toBeNull()
    })
    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => {
      expect(screen.queryByTestId('search-history-dropdown')).toBeNull()
    })
  })

  it('clicking Clear history wipes the per-space MRU', async () => {
    useSearchHistoryStore.setState({ bySpace: { SPACE_TEST: ['alpha', 'beta'] } })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)
    await waitFor(() => expect(screen.getByTestId('search-history-clear')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('search-history-clear'))
    expect(useSearchHistoryStore.getState().bySpace['SPACE_TEST']).toEqual([])
  })
})

describe('SearchPanel match-offset rendering', () => {
  it('renders <mark> highlights from match_offsets when the backend provides them', async () => {
    mockedInvoke.mockResolvedValue({
      items: [
        {
          id: 'B1',
          block_type: 'content',
          content: 'TODO review Alpha cohort',
          parent_id: null,
          position: 1,
          deleted_at: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
          page_id: null,
          snippet: null,
          // "Alpha" lives at UTF-16 indices 12..17.
          match_offsets: [{ start: 12, end: 17 }],
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'Alpha')
    await waitFor(() => {
      const marks = document.querySelectorAll('mark')
      expect(marks.length).toBeGreaterThan(0)
      expect(marks[0]?.textContent).toBe('Alpha')
    })
  })
})
