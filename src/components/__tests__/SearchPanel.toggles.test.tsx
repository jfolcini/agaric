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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '../../stores/navigation'
import { useSearchHistoryStore } from '../../stores/search-history'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { SearchPanel } from '../SearchPanel'

// PEND-58f FE-3 — virtualized result listbox: render every row in jsdom
// (zero-height scroll container would otherwise window to zero rows) so the
// match-offset `<mark>` assertion below can find the rendered row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const sizes = Array.from({ length: opts.count }, (_, i) => opts.estimateSize(i))
    let start = 0
    const items = sizes.map((size, index) => {
      const item = { index, key: index, start, size, end: start + size }
      start += size
      return item
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => start,
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
      measureElement: vi.fn(),
    }
  },
}))

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

// DSL-A8 — the raw query string forwarded to `search_blocks`. In regex
// mode this must be the parsed free-text remainder (the regex pattern),
// NOT the full input including filter tokens like `tag:`.
function lastQuery(): string | null {
  const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'search_blocks')
  if (calls.length === 0) return null
  const last = calls[calls.length - 1] as unknown as [string, { query: string }]
  return last[1].query
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

    // PEND-58g NEW-2 — flipping regex mode swaps in the regex placeholder.
    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    typeAndSubmit(input, '^TODO')

    await waitFor(() => {
      const filter = lastFilter()
      expect(filter).not.toBeNull()
      expect(filter?.['isRegex']).toBe(true)
      expect(filter?.['caseSensitive']).toBe(false)
      expect(filter?.['wholeWord']).toBe(false)
    })
  })

  // DSL-A8 / UX-A4 — regex mode is symmetric with non-regex mode: filter
  // tokens are parsed OUT of the input and applied as structural SQL
  // filters; only the remaining free text is the regex pattern.
  it('regex mode applies structural filters AND sends only the free text as the pattern', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_WIP', name: 'wip', color: null }]
      }
      return emptyPage
    })
    render(<SearchPanel />)

    fireEvent.click(screen.getByTestId('search-toggle-regex'))

    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    typeAndSubmit(input, 'tag:wip foo.*')

    // The tag name resolves asynchronously via `list_tags_by_prefix`;
    // wait until the resolved id reaches the IPC payload.
    await waitFor(() => {
      const filter = lastFilter()
      expect(filter?.['tagIds']).toEqual(['TAG_WIP'])
    })

    const filter = lastFilter()
    expect(filter?.['isRegex']).toBe(true)
    // The regex pattern is the free text only — `tag:wip` was stripped.
    expect(lastQuery()).toBe('foo.*')
  })

  it('regex mode still renders the tag chip parsed from the input', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_WIP', name: 'wip', color: null }]
      }
      return emptyPage
    })
    render(<SearchPanel />)

    fireEvent.click(screen.getByTestId('search-toggle-regex'))

    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    fireEvent.change(input, { target: { value: 'tag:wip foo.*' } })

    // Chips render from the live AST regardless of mode. The chip label
    // is the canonical token source (`tag:#wip`).
    await waitFor(() => {
      const chipBar = screen.getByTestId('filter-chip-bar')
      expect(within(chipBar).getByText('tag:#wip')).toBeInTheDocument()
    })
  })

  it('regex mode fires the IPC for a filter-only query (no free text)', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_tags_by_prefix') {
        return [{ tag_id: 'TAG_WIP', name: 'wip', color: null }]
      }
      return emptyPage
    })
    render(<SearchPanel />)

    fireEvent.click(screen.getByTestId('search-toggle-regex'))

    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    typeAndSubmit(input, 'tag:wip')

    await waitFor(() => {
      expect(lastFilter()?.['tagIds']).toEqual(['TAG_WIP'])
    })
    // Free text is empty (only the filter token was typed), so the regex
    // pattern sent is '' — the filter travels via `tagIds`, not the pattern.
    expect(lastQuery()).toBe('')
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

// PEND-58g NEW-2 — a visual + a11y cue that the input free-text is matched
// as a regular expression when regex mode is on.
describe('SearchPanel regex-mode input cue (PEND-58g NEW-2)', () => {
  it('off by default: normal placeholder, no font-mono, no regex hint', () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    expect(input).toBeInTheDocument()
    expect(input).not.toHaveClass('font-mono')
    expect(input).not.toHaveAttribute('aria-describedby', 'search-regex-hint')
    expect(screen.queryByText(t('search.regexModeHint'))).not.toBeInTheDocument()
  })

  it('on: regex placeholder + font-mono + aria-describedby wired to the sr-only hint', () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    fireEvent.click(screen.getByTestId('search-toggle-regex'))

    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    expect(input).toHaveClass('font-mono')
    expect(input).toHaveClass('flex-1')
    expect(input).toHaveAttribute('aria-describedby', 'search-regex-hint')

    const hint = document.getElementById('search-regex-hint')
    expect(hint).not.toBeNull()
    expect(hint).toHaveClass('sr-only')
    expect(hint).toHaveTextContent(t('search.regexModeHint'))
  })

  it('has no a11y violations with the regex cue showing', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    const { container } = render(<SearchPanel />)
    fireEvent.click(screen.getByTestId('search-toggle-regex'))
    // The describedby target must exist for the input that references it.
    expect(screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))).toHaveAttribute(
      'aria-describedby',
      'search-regex-hint',
    )
    expect(await axe(container)).toHaveNoViolations()
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

describe('SearchPanel invalid-regex announcement (UX-A2)', () => {
  it('does not double-announce: the status live region stays silent on an invalid regex', async () => {
    // The backend rejects an unparseable pattern with the `InvalidRegex:`
    // prefix; SearchPanel surfaces the specific message inline in the
    // header. The generic "Search failed" status branch must NOT also
    // fire (that would double-announce to screen readers).
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'search_blocks') {
        throw new Error('InvalidRegex: unclosed group at position 0')
      }
      return emptyPage
    })
    render(<SearchPanel />)

    fireEvent.click(screen.getByTestId('search-toggle-regex'))
    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    typeAndSubmit(input, '(')

    // The inline regex error owns the failure.
    await waitFor(() => {
      expect(screen.getByTestId('search-inline-error')).toBeInTheDocument()
    })

    // The `role="status"` live region does NOT announce the generic error.
    const status = screen.getByTestId('search-results-status')
    expect(status).not.toHaveTextContent(t('search.statusError'))
    expect(within(status).queryByTestId('search-results-count')).toBeNull()
  })

  it('does NOT surface the inline regex alert for an `InvalidRegex:` error when regex mode is OFF', async () => {
    // PEND-70 CR11 — case-sensitive / whole-word mode builds a *literal*
    // match regex server-side; an oversized literal makes the backend reject
    // with an `InvalidRegex:`-prefixed message even though the user never
    // enabled regex. The inline "invalid regex" alert must NOT fire in that
    // case — the failure falls through to the generic error body + status.
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'search_blocks') {
        throw new Error('InvalidRegex: pattern too large')
      }
      return emptyPage
    })
    render(<SearchPanel />)

    // Regex toggle stays OFF (the default); use the case-sensitive toggle to
    // reflect the literal-match mode that triggers the backend rejection.
    const caseButton = screen.getByTestId('search-toggle-case-sensitive')
    fireEvent.click(caseButton)
    expect(caseButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('search-toggle-regex')).toHaveAttribute('aria-pressed', 'false')

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'a'.repeat(50))

    // The generic error body owns the failure...
    await waitFor(() => {
      expect(screen.getByTestId('search-error-state')).toBeInTheDocument()
    })
    // ...and the inline regex alert must never appear in non-regex mode.
    expect(screen.queryByTestId('search-inline-error')).toBeNull()
    // The status region announces the generic failure (not a double-suppress).
    expect(screen.getByTestId('search-results-status')).toHaveTextContent(t('search.statusError'))
  })

  it('still announces the generic failure for a non-regex backend error', async () => {
    // A plain backend error (no `InvalidRegex:` prefix) must still light
    // up the status region — UX-A2 only suppresses the regex case.
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'search_blocks') {
        throw new Error('database is locked')
      }
      return emptyPage
    })
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'hello')

    await waitFor(() => {
      const status = screen.getByTestId('search-results-status')
      expect(status).toHaveTextContent(t('search.statusError'))
    })
    expect(screen.queryByTestId('search-inline-error')).toBeNull()
  })

  it('has no a11y violations while showing an invalid-regex error', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'search_blocks') {
        throw new Error('InvalidRegex: unclosed group at position 0')
      }
      return emptyPage
    })
    const { container } = render(<SearchPanel />)
    fireEvent.click(screen.getByTestId('search-toggle-regex'))
    const input = screen.getByPlaceholderText(t('search.searchPlaceholderRegex'))
    typeAndSubmit(input, '(')
    await waitFor(() => {
      expect(screen.getByTestId('search-inline-error')).toBeInTheDocument()
    })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('SearchPanel history dropdown aria parity (FE-A13)', () => {
  it('does not advertise a listbox when history is disabled+empty (no dangling aria-controls)', async () => {
    // Recording OFF + zero entries: the dropdown shell is still shown (so
    // the Enable toggle stays reachable) but it renders NO `role="listbox"`
    // element. The combobox must therefore NOT report itself expanded into
    // a listbox, and must not reference a non-existent `aria-controls` id.
    useSearchHistoryStore.setState({ bySpace: {}, historyEnabled: false })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)

    await waitFor(() => {
      expect(screen.getByTestId('search-history-dropdown')).toBeInTheDocument()
    })
    // No listbox is rendered in the empty case…
    expect(screen.queryByTestId('search-history-list')).toBeNull()
    // …so the combobox must not claim to be expanded/controlling one.
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-controls')
  })

  it('advertises the history listbox when entries exist (aria-controls resolves)', async () => {
    // Recording OFF but with prior entries: the `role="listbox"` renders,
    // so the combobox is expanded and `aria-controls` must point at the
    // listbox element that actually exists in the DOM.
    useSearchHistoryStore.setState({
      bySpace: { SPACE_TEST: ['recent A', 'recent B'] },
      historyEnabled: false,
    })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)

    const listbox = await screen.findByTestId('search-history-list')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    const controls = input.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    // The referenced id must resolve to the rendered listbox element.
    expect(listbox).toHaveAttribute('id', controls)
  })

  it('aria-expanded is false when the dropdown is not shown (focused but typing)', async () => {
    useSearchHistoryStore.setState({ bySpace: {}, historyEnabled: false })
    mockedInvoke.mockResolvedValue(emptyPage)
    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x' } })

    await waitFor(() => {
      expect(screen.queryByTestId('search-history-dropdown')).toBeNull()
    })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-controls')
  })
})
