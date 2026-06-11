/**
 * Tests for SearchPanel — E2E-A4 (PEND-58g): the capped (5000) result notice.
 *
 * The cap arithmetic itself is unit-tested in
 * `src/hooks/__tests__/usePaginatedQuery.test.ts`. This file covers ONLY the
 * notice rendering: `capped` flows from `usePaginatedQuery` →
 * `useSearchResults` → SearchPanel, which renders
 * `{capped && (<div data-testid="search-capped-notice">…)}`.
 *
 * We mock `usePaginatedQuery` so the hook returns a controlled
 * `UsePaginatedQueryResult`, and assert the notice's presence/absence + its
 * localised copy.
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { t } from '@/lib/i18n'

import { useNavigationStore } from '../../stores/navigation'
import { useSearchHistoryStore } from '../../stores/search-history'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { SearchPanel } from '../SearchPanel'

// PEND-58f FE-3 — mirror the main SearchPanel.test.tsx virtualizer mock so
// jsdom's zero-height scroll container doesn't collapse the virtual window.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

// UX-153: Mock resolvePageByAlias separately so alias-resolution calls don't
// consume values from the FIFO invoke mock queue.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    resolvePageByAlias: vi.fn().mockResolvedValue(null),
  }
})

import { resolvePageByAlias } from '../../lib/tauri'

// E2E-A4 — controlled `usePaginatedQuery` so we drive `capped` directly. The
// returned shape is the FULL `UsePaginatedQueryResult` interface (see
// `src/hooks/usePaginatedQuery.ts`). `cappedValue` is mutated per-test before
// each render.
let cappedValue = false
let mockedItems: unknown[] = []
vi.mock('../../hooks/usePaginatedQuery', () => ({
  usePaginatedQuery: () => ({
    items: mockedItems,
    loading: false,
    hasMore: false,
    capped: cappedValue,
    error: null,
    loadMore: vi.fn(),
    reload: vi.fn(),
    setItems: vi.fn(),
    totalCount: undefined,
  }),
}))

const makeSearchResult = (overrides?: Partial<Record<string, unknown>>) => ({
  id: 'BLOCK1',
  block_type: 'content',
  content: 'capped content',
  parent_id: null,
  // page_id: null so no `batchResolve` IPC fires for breadcrumb resolution.
  page_id: null,
  position: 1,
  deleted_at: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  cappedValue = false
  mockedItems = []
  vi.mocked(resolvePageByAlias).mockResolvedValue(null)
  useNavigationStore.setState({
    currentView: 'search',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSearchHistoryStore.setState({ bySpace: {}, historyEnabled: true })
  // FEAT-3 Phase 2 — SearchPanel gates on `useSpaceStore.isReady`; seed it so
  // the render gets past the loading skeleton.
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

describe('SearchPanel — capped notice (E2E-A4)', () => {
  it('renders the capped notice when usePaginatedQuery reports capped: true', () => {
    cappedValue = true
    mockedItems = [makeSearchResult()]

    render(<SearchPanel />)

    const notice = screen.getByTestId('search-capped-notice')
    expect(notice).toBeInTheDocument()
    expect(notice).toHaveTextContent(t('search.cappedNotice'))
  })

  it('does not render the capped notice when capped: false', () => {
    cappedValue = false
    mockedItems = [makeSearchResult()]

    render(<SearchPanel />)

    expect(screen.queryByTestId('search-capped-notice')).toBeNull()
  })

  it('has no a11y violations in the capped state', async () => {
    cappedValue = true
    mockedItems = [makeSearchResult()]

    let container!: HTMLElement
    await act(async () => {
      ;({ container } = render(<SearchPanel />))
    })

    expect(screen.getByTestId('search-capped-notice')).toBeInTheDocument()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
