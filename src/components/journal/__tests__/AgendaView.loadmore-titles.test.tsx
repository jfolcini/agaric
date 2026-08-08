/**
 * Tests for AgendaView page-title resolution across load-more (#3340).
 *
 * Title resolution used to live inside the initial-query effect, whose deps
 * (`agendaFilters` / `refreshKey` / `currentSpaceId`) none of which change when
 * `loadMoreAgenda` appends a page. Appended rows therefore rendered their
 * breadcrumb as "Untitled" and — since `groupBy` defaults to 'page' —
 * `groupByPage` labelled their group with the raw page ULID and sorted that
 * pseudo-title alphabetically among the real ones.
 *
 * These tests render the REAL `AgendaResults`, so the assertions are on the
 * breadcrumb text and the group headers the user actually sees, not on a stub's
 * captured props.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

// happy-dom's zero-height scroll container collapses the virtual list to zero
// rows; without this the "appended row" assertions would be vacuously true.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

vi.mock('@/hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

vi.mock('@/lib/agenda-filters', () => ({
  executeAgendaFilters: vi.fn(),
  loadMoreAgendaFilters: vi.fn(),
  loadMoreUnfilteredAgenda: vi.fn(),
}))

const { mockGetProperties, mockGetBatchProperties, mockBatchResolve } = vi.hoisted(() => ({
  mockGetProperties: vi.fn(),
  mockGetBatchProperties: vi.fn(),
  mockBatchResolve: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  getProperties: (...args: unknown[]) => mockGetProperties(...args),
  getBatchProperties: (...args: unknown[]) => mockGetBatchProperties(...args),
  batchResolve: (...args: unknown[]) => mockBatchResolve(...args),
  queryByProperty: vi.fn(),
  paginationLimit: (n: number) => n,
  getBlock: vi.fn(),
  setDueDate: vi.fn(),
  setScheduledDate: vi.fn(),
}))

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getProperties: (...args: unknown[]) =>
        mockGetProperties(...args).then((data: unknown) => ({ status: 'ok', data })),
      getBatchProperties: (...args: unknown[]) =>
        mockGetBatchProperties(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

// The filter builder is heavy and irrelevant here; the results list is what
// these tests assert on, so it stays real.
vi.mock('@/components/agenda/AgendaFilterBuilder', () => ({
  AgendaFilterBuilder: () => <div data-testid="agenda-filter-builder" />,
  AgendaSortGroupControls: () => <div data-testid="agenda-sort-group-controls" />,
}))

import { makeBlock as _makeBlock } from '@/__tests__/fixtures'
import { AgendaView } from '@/components/journal/AgendaView'
import { executeAgendaFilters, loadMoreAgendaFilters } from '@/lib/agenda-filters'
import { t } from '@/lib/i18n'

const mockedExecuteAgendaFilters = vi.mocked(executeAgendaFilters)
const mockedLoadMoreAgendaFilters = vi.mocked(loadMoreAgendaFilters)

/**
 * Two page ULIDs chosen so the BUG is visible in the ordering, not only in the
 * header text: the appended page's ULID sorts BEFORE the first page's real
 * title (digits precede letters), while its real title sorts AFTER it. A
 * regression therefore both mislabels and reorders the groups.
 */
const PAGE_FIRST = '01HMMMMMMMMMMMMMMMMMMMMMMM'
const PAGE_APPENDED = '01HAAAAAAAAAAAAAAAAAAAAAAA'

const TITLE_FIRST = 'Alpha Notes'
const TITLE_APPENDED = 'Zulu Notes'

const TITLES: Record<string, string> = {
  [PAGE_FIRST]: TITLE_FIRST,
  [PAGE_APPENDED]: TITLE_APPENDED,
}

/** Matches a canonical Crockford ULID — what a group header must never be. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

const makeBlock = (overrides: Parameters<typeof _makeBlock>[0] = {}) =>
  _makeBlock({
    block_type: 'block',
    todo_state: 'TODO',
    ...overrides,
  })

const initialBlock = makeBlock({
  id: '01BINITIALINITIALINITIALIN',
  content: 'initial task',
  parent_id: PAGE_FIRST,
  page_id: PAGE_FIRST,
})

const appendedBlock = makeBlock({
  id: '01BAPPENDEDAPPENDEDAPPENDE',
  content: 'appended task',
  parent_id: PAGE_APPENDED,
  page_id: PAGE_APPENDED,
})

/** Group-header labels in rendered order, with the trailing `(n)` count removed. */
function groupHeaderLabels(): string[] {
  return screen
    .getAllByTestId('agenda-group-header')
    .map((h) => h.childNodes[0]?.textContent?.trim() ?? '')
}

/** The breadcrumb text of the row whose content is `content`. */
function breadcrumbOf(content: string): string {
  const row = screen.getByText(content).closest('li')
  if (!row) throw new Error(`no row for "${content}"`)
  return row.querySelector('.agenda-results-breadcrumb')?.textContent?.trim() ?? ''
}

async function clickLoadMore(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: t('agenda.loadMoreLabel') }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockGetProperties.mockResolvedValue([])
  mockGetBatchProperties.mockResolvedValue({})
  // Resolve whatever ids the caller asks for — the point of these tests is
  // WHICH ids AgendaView asks about, and when.
  mockBatchResolve.mockImplementation((ids: string[]) =>
    Promise.resolve(
      ids
        .filter((id) => id in TITLES)
        .map((id) => ({ id, title: TITLES[id], block_type: 'page', deleted: false })),
    ),
  )
  mockedExecuteAgendaFilters.mockResolvedValue({
    blocks: [initialBlock],
    hasMore: true,
    cursor: 'cursor_page2',
  })
  mockedLoadMoreAgendaFilters.mockResolvedValue({
    blocks: [appendedBlock],
    hasMore: false,
    cursor: null,
  })
})

describe('AgendaView load-more page titles (#3340)', () => {
  it('resolves the breadcrumb title for rows appended by load-more', async () => {
    const user = userEvent.setup()
    render(<AgendaView />)

    await waitFor(() => {
      expect(breadcrumbOf('initial task')).toContain(TITLE_FIRST)
    })

    await clickLoadMore(user)

    // The appended row must actually render (guards against a vacuous pass)…
    await waitFor(() => {
      expect(screen.getByText('appended task')).toBeInTheDocument()
    })
    // …and its breadcrumb must carry the resolved title, not the fallback.
    await waitFor(() => {
      expect(breadcrumbOf('appended task')).toContain(TITLE_APPENDED)
    })
    expect(breadcrumbOf('appended task')).not.toContain(t('agenda.untitled'))
  })

  it('labels and orders the appended group by its title, never by its ULID', async () => {
    const user = userEvent.setup()
    render(<AgendaView />)

    await waitFor(() => {
      expect(groupHeaderLabels()).toEqual([TITLE_FIRST])
    })

    await clickLoadMore(user)

    await waitFor(() => {
      expect(screen.getByText('appended task')).toBeInTheDocument()
    })
    // Alphabetical by RESOLVED title. With the appended page unresolved its
    // group is labelled `PAGE_APPENDED` and sorts to the front instead.
    await waitFor(() => {
      expect(groupHeaderLabels()).toEqual([TITLE_FIRST, TITLE_APPENDED])
    })
    for (const label of groupHeaderLabels()) {
      expect(label).not.toMatch(ULID_RE)
    }
  })

  it('keeps already-resolved titles when a later resolve returns nothing', async () => {
    const user = userEvent.setup()
    render(<AgendaView />)

    await waitFor(() => {
      expect(groupHeaderLabels()).toEqual([TITLE_FIRST])
    })

    // The load-more resolve comes back empty (partial backend response). The
    // merge must not drop the title already resolved for the first page.
    mockBatchResolve.mockResolvedValue([])

    await clickLoadMore(user)

    await waitFor(() => {
      expect(screen.getByText('appended task')).toBeInTheDocument()
    })
    expect(groupHeaderLabels()).toContain(TITLE_FIRST)
    expect(breadcrumbOf('initial task')).toContain(TITLE_FIRST)
  })

  it('has no a11y violations after loading more', async () => {
    const user = userEvent.setup()
    const { container } = render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByText('initial task')).toBeInTheDocument()
    })
    await clickLoadMore(user)
    await waitFor(() => {
      expect(screen.getByText('appended task')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('renders both groups as real list rows (guards the assertions above)', async () => {
    const user = userEvent.setup()
    render(<AgendaView />)

    await waitFor(() => {
      expect(screen.getByText('initial task')).toBeInTheDocument()
    })
    await clickLoadMore(user)
    await waitFor(() => {
      expect(screen.getByText('appended task')).toBeInTheDocument()
    })

    const headers = screen.getAllByTestId('agenda-group-header')
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      expect(within(header).getByText('(1)')).toBeInTheDocument()
    }
  })
})
