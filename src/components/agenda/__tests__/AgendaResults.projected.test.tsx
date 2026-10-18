/**
 * AgendaResults — projected occurrences of repeating tasks (#5735).
 *
 * A separate file from `AgendaResults.test.tsx` because that suite stubs
 * `lucide-react` with a hand-listed icon set, and the projected row's
 * `Repeat` icon is not in it.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

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

const { mockGetBatchProperties } = vi.hoisted(() => ({ mockGetBatchProperties: vi.fn() }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      getBatchProperties: (...args: unknown[]) =>
        mockGetBatchProperties(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: () => Promise.resolve({ status: 'ok', data: [] }),
    },
  }
})

import { makeBlockRow, makeProjectedEntry } from '@/__tests__/fixtures'
import { AgendaResults, type AgendaResultsProps } from '@/components/agenda/AgendaResults'
import type { AgendaProjectedEntries } from '@/hooks/useAgendaProjectedEntries'
import { formatCompactDate } from '@/lib/date-utils'
import { t } from '@/lib/i18n'

const committed = makeBlockRow({
  id: 'B1',
  content: 'Committed task',
  todo_state: 'TODO',
  due_date: '2026-10-20',
  page_id: 'PAGE1',
})
const thisWeek = makeProjectedEntry({ projected_date: '2026-10-18', block: { page_id: 'PAGE2' } })
const nextWeek = makeProjectedEntry({ projected_date: '2026-10-25', block: { page_id: 'PAGE2' } })

function projectedOf(
  entries: AgendaProjectedEntries['entries'],
  overrides: Partial<AgendaProjectedEntries> = {},
): AgendaProjectedEntries {
  return { entries, hasMore: false, loadingMore: false, loadMore: vi.fn(), ...overrides }
}

function props(overrides: Partial<AgendaResultsProps> = {}): AgendaResultsProps {
  return {
    blocks: [committed],
    loading: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    hasActiveFilters: false,
    onClearFilters: vi.fn(),
    pageTitles: new Map([['PAGE2', 'Chores']]),
    groupBy: 'none',
    projected: projectedOf([thisWeek, nextWeek]),
    ...overrides,
  }
}

const projectedList = () => screen.getByRole('list', { name: t('duePanel.projectedListLabel') })

beforeEach(() => {
  vi.clearAllMocks()
  mockGetBatchProperties.mockResolvedValue({})
})

describe('AgendaResults projected occurrences', () => {
  it('lists each occurrence after the committed tasks, labelled and dated', () => {
    render(<AgendaResults {...props()} />)

    const rows = within(projectedList()).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('time')?.getAttribute('dateTime'))).toEqual([
      '2026-10-18',
      '2026-10-25',
    ])
    for (const row of rows) {
      expect(row).toHaveTextContent(t('duePanel.projectedBadge'))
      expect(row).toHaveTextContent('Water plants')
    }
    expect(rows[1]).toHaveTextContent(formatCompactDate('2026-10-25'))
    // The committed count stays the committed tasks'.
    expect(screen.getByText(t('agenda.resultOne'))).toBeInTheDocument()
  })

  it('still lists occurrences when no committed task matches', () => {
    render(<AgendaResults {...props({ blocks: [], hasActiveFilters: true })} />)

    expect(screen.getByText(t('agenda.noMatch'))).toBeInTheDocument()
    expect(within(projectedList()).getAllByRole('listitem')).toHaveLength(2)
  })

  it('reaches an occurrence with the arrow keys and opens its task with Enter', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    render(<AgendaResults {...props({ onNavigateToPage })} />)

    await user.click(screen.getByText('Committed task'))
    onNavigateToPage.mockClear()
    await user.keyboard('{ArrowDown}')
    const [first] = within(projectedList()).getAllByRole('listitem')
    await waitFor(() => expect(first).toHaveFocus())
    await user.keyboard('{Enter}')

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE2', 'Chores', 'REPEAT1')
  })

  it('offers its own Load more while the projection has more pages', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn()
    render(
      <AgendaResults
        {...props({ projected: projectedOf([thisWeek], { hasMore: true, loadMore }) })}
      />,
    )

    await user.click(screen.getByRole('button', { name: t('agenda.loadMoreProjectedLabel') }))

    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('renders no projected list without occurrences', () => {
    render(<AgendaResults {...props({ projected: projectedOf([]) })} />)
    expect(screen.getByText('Committed task')).toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: t('duePanel.projectedListLabel') }),
    ).not.toBeInTheDocument()
  })

  it('degrades to the rows when the batch property fetch rejects', async () => {
    mockGetBatchProperties.mockRejectedValue(new Error('backend down'))
    render(<AgendaResults {...props()} />)
    await waitFor(() => expect(mockGetBatchProperties).toHaveBeenCalled())
    expect(within(projectedList()).getAllByRole('listitem')).toHaveLength(2)
  })

  it('has no a11y violations with occurrences listed', async () => {
    const { container } = render(<AgendaResults {...props()} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('has no a11y violations with occurrences under an empty committed list', async () => {
    const { container } = render(<AgendaResults {...props({ blocks: [] })} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
