/**
 * Integration tests for PEND-50 Phase 1 — page-grouped search result
 * rendering, `<mark>` snippet highlighting, and the result count summary.
 *
 * These cases live in a new file (not `SearchPanel.test.tsx`) so the
 * page-grouping surface stays auditable in isolation as PEND-51 / 54 /
 * 55 / 53 extend it.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '../../stores/navigation'
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

interface SearchRowOverrides {
  id?: string
  block_type?: string
  content?: string | null
  parent_id?: string | null
  page_id?: string | null
  snippet?: string | null
}

function makeSearchRow(o: SearchRowOverrides = {}) {
  return {
    id: o.id ?? 'BLK',
    block_type: o.block_type ?? 'content',
    content: o.content ?? null,
    parent_id: o.parent_id ?? null,
    page_id: o.page_id ?? null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: o.snippet ?? null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useNavigationStore.setState({ currentView: 'search', selectedBlockId: null })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

function typeAndSubmit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  const form = input.closest('form')
  if (form) fireEvent.submit(form)
}

describe('PEND-50 Phase 1 — SearchPanel page grouping', () => {
  it('renders 3 listboxes for 9 matches across 3 pages with correct per-group counts', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({ id: 'B1', page_id: 'PAGE_A', snippet: 'first <mark>alpha</mark> hit' }),
            makeSearchRow({ id: 'B2', page_id: 'PAGE_A', snippet: 'second <mark>alpha</mark>' }),
            makeSearchRow({ id: 'B3', page_id: 'PAGE_A', snippet: 'third <mark>alpha</mark>' }),
            makeSearchRow({ id: 'B4', page_id: 'PAGE_B', snippet: '<mark>alpha</mark> in B' }),
            makeSearchRow({ id: 'B5', page_id: 'PAGE_B', snippet: 'more <mark>alpha</mark>' }),
            makeSearchRow({ id: 'B6', page_id: 'PAGE_C', snippet: '<mark>alpha</mark>' }),
            makeSearchRow({ id: 'B7', page_id: 'PAGE_C', snippet: '<mark>alpha</mark>' }),
            makeSearchRow({ id: 'B8', page_id: 'PAGE_C', snippet: '<mark>alpha</mark>' }),
            makeSearchRow({ id: 'B9', page_id: 'PAGE_C', snippet: '<mark>alpha</mark>' }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [
          { id: 'PAGE_A', title: 'Project Alpha', block_type: 'page', deleted: false },
          { id: 'PAGE_B', title: 'Daily 2026-05-12', block_type: 'page', deleted: false },
          { id: 'PAGE_C', title: 'Roadmap', block_type: 'page', deleted: false },
        ]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    await waitFor(() => {
      const listboxes = screen.getAllByRole('listbox')
      expect(listboxes).toHaveLength(3)
    })

    // Per-group counts surface through the group header labels.
    expect(screen.getByText(t('search.matchCountInGroupPlural', { count: 3 }))).toBeInTheDocument()
    expect(screen.getByText(t('search.matchCountInGroupPlural', { count: 2 }))).toBeInTheDocument()
    expect(screen.getByText(t('search.matchCountInGroupPlural', { count: 4 }))).toBeInTheDocument()
  })

  it('renders the result count summary above the first group', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({ id: 'B1', page_id: 'PAGE_A', snippet: '<mark>x</mark>' }),
            makeSearchRow({ id: 'B2', page_id: 'PAGE_A', snippet: '<mark>x</mark>' }),
            makeSearchRow({ id: 'B3', page_id: 'PAGE_B', snippet: '<mark>x</mark>' }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [
          { id: 'PAGE_A', title: 'A', block_type: 'page', deleted: false },
          { id: 'PAGE_B', title: 'B', block_type: 'page', deleted: false },
        ]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'x')

    await waitFor(() => {
      const summary = screen.getByTestId('search-result-count-summary')
      expect(summary).toHaveTextContent(
        t('search.matchCountPlural', { matchCount: 3, pageCount: 2 }),
      )
    })
  })

  it('renders <mark> highlight spans inside matching block rows', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'B1',
              page_id: 'PAGE_A',
              snippet: 'reviewed the <mark>alpha</mark> plan',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE_A', title: 'Diary', block_type: 'page', deleted: false }]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    const option = await screen.findByRole('option')
    const mark = option.querySelector('mark.search-result-mark')
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toBe('alpha')
  })

  it('clicking a block row navigates to that block (parent page resolved)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'BLK1',
              parent_id: 'PAGE_A',
              page_id: 'PAGE_A',
              snippet: '<mark>alpha</mark> body',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE_A', title: 'Project Alpha', block_type: 'page', deleted: false }]
      }
      if (cmd === 'get_block') {
        const a = args as { blockId: string }
        if (a.blockId === 'PAGE_A') {
          return {
            id: 'PAGE_A',
            block_type: 'page',
            content: 'Project Alpha',
            parent_id: null,
            position: 0,
            deleted_at: null,
          }
        }
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    const option = await screen.findByRole('option')
    await user.click(option)

    await waitFor(() => {
      expect(useNavigationStore.getState().currentView).toBe('page-editor')
      expect(useTabsStore.getState().tabs[0]?.pageStack[0]?.pageId).toBe('PAGE_A')
    })
  })

  it('clicking a page group header navigates to that page', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'BLK1',
              page_id: 'PAGE_A',
              snippet: '<mark>alpha</mark>',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE_A', title: 'Project Alpha', block_type: 'page', deleted: false }]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    const pageLink = await screen.findByRole('link', { name: 'Project Alpha' })
    await user.click(pageLink)

    await waitFor(() => {
      expect(useTabsStore.getState().tabs[0]?.pageStack[0]?.pageId).toBe('PAGE_A')
    })
  })

  it('group collapse state is preserved across re-renders', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'B1',
              page_id: 'PAGE_A',
              snippet: '<mark>x</mark>',
            }),
            makeSearchRow({
              id: 'B2',
              page_id: 'PAGE_B',
              snippet: '<mark>x</mark>',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [
          { id: 'PAGE_A', title: 'A', block_type: 'page', deleted: false },
          { id: 'PAGE_B', title: 'B', block_type: 'page', deleted: false },
        ]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'x')

    await waitFor(() => {
      expect(screen.getAllByRole('listbox')).toHaveLength(2)
    })

    // Collapse the first group by clicking its chevron button.
    const expanders = screen.getAllByRole('button', { name: t('group.collapseGroup') })
    expect(expanders.length).toBeGreaterThan(0)
    if (expanders[0]) await user.click(expanders[0])

    // After collapse: only the second listbox remains, and the now-
    // collapsed group surfaces a "show" button (aria-label flips to
    // `group.expandGroup`).
    await waitFor(() => {
      expect(screen.getAllByRole('listbox')).toHaveLength(1)
    })
    expect(screen.getAllByRole('button', { name: t('group.expandGroup') }).length).toBe(1)
  })

  it('resets group collapse state when the query changes', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'B1',
              page_id: 'PAGE_A',
              snippet: '<mark>x</mark>',
            }),
            makeSearchRow({
              id: 'B2',
              page_id: 'PAGE_B',
              snippet: '<mark>x</mark>',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [
          { id: 'PAGE_A', title: 'A', block_type: 'page', deleted: false },
          { id: 'PAGE_B', title: 'B', block_type: 'page', deleted: false },
        ]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder'))
    typeAndSubmit(input, 'x')

    await waitFor(() => {
      expect(screen.getAllByRole('listbox')).toHaveLength(2)
    })

    const expanders = screen.getAllByRole('button', { name: t('group.collapseGroup') })
    if (expanders[0]) await user.click(expanders[0])
    await waitFor(() => {
      expect(screen.getAllByRole('listbox')).toHaveLength(1)
    })

    // Re-issue the search with a new query — expand state must reset.
    typeAndSubmit(input, 'y')
    await waitFor(() => {
      // Both groups should be expanded again (defaultExpanded=true
      // gates on `expandedGroups[id] ?? true`).
      expect(screen.getAllByRole('listbox')).toHaveLength(2)
    })
  })

  it('renders the page-name-only label for content-less page hits', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            // A page-type hit on the title (no content snippet) —
            // PEND-50 recommendation: "1 match (in name)".
            makeSearchRow({
              id: 'PAGE_A',
              block_type: 'page',
              content: 'Project Alpha',
              page_id: null,
              snippet: null,
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    await waitFor(() => {
      expect(screen.getByText(t('search.matchCountInGroupNameOnly'))).toBeInTheDocument()
    })
  })

  it('outer region carries role=region and the localised aria-label', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'B1',
              page_id: 'PAGE_A',
              snippet: '<mark>x</mark>',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE_A', title: 'A', block_type: 'page', deleted: false }]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'x')

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: t('search.resultsRegionLabel') }),
      ).toBeInTheDocument()
    })
  })

  it('listbox carries aria-activedescendant pointing at the focused row', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({ id: 'B1', page_id: 'PAGE_A', snippet: '<mark>x</mark>' }),
            makeSearchRow({ id: 'B2', page_id: 'PAGE_A', snippet: '<mark>x</mark>' }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [{ id: 'PAGE_A', title: 'A', block_type: 'page', deleted: false }]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'x')

    await waitFor(() => {
      const lb = screen.getByRole('listbox')
      expect(lb).toHaveAttribute('aria-activedescendant', 'search-result-B1')
    })
  })

  it('axe: page-grouped result tree has no a11y violations', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'search_blocks') {
        return {
          items: [
            makeSearchRow({
              id: 'B1',
              page_id: 'PAGE_A',
              snippet: 'first <mark>alpha</mark>',
            }),
            makeSearchRow({
              id: 'B2',
              page_id: 'PAGE_B',
              snippet: 'second <mark>alpha</mark>',
            }),
          ],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      if (cmd === 'batch_resolve') {
        return [
          { id: 'PAGE_A', title: 'Project Alpha', block_type: 'page', deleted: false },
          { id: 'PAGE_B', title: 'Diary', block_type: 'page', deleted: false },
        ]
      }
      return emptyPage
    })

    const { container } = render(<SearchPanel />)
    typeAndSubmit(screen.getByPlaceholderText(t('search.searchPlaceholder')), 'alpha')

    await waitFor(() => {
      expect(screen.getAllByRole('listbox')).toHaveLength(2)
    })

    // Let any deferred effects (breadcrumb resolution) settle.
    await act(async () => {
      await Promise.resolve()
    })

    const region = screen.getByRole('region', { name: t('search.resultsRegionLabel') })
    expect(within(region).getAllByRole('listbox')).toHaveLength(2)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
