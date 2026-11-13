import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { boardColumns } from '@/components/AdvancedQuery/board-columns'
import { QueryBoard } from '@/components/AdvancedQuery/QueryBoard'
import type {
  ActiveBlockRow,
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  FilterExpr,
  PropertyDefinition,
} from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const BASE_FILTER: FilterExpr = { type: 'And', children: [] }
const STATE_COLUMNS = boardColumns({ key: { type: 'State' } }, undefined) ?? []

function row(id: string, over: Partial<ActiveBlockRow> = {}): ActiveBlockRow & { score: null } {
  return {
    id,
    block_type: 'content',
    content: `card ${id}`,
    parent_id: 'PAGE001',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE001',
    score: null,
    ...over,
  }
}

/** The task state a column's request asks for; `none` for the no-state column. */
function requestedState(request: AdvancedQueryRequest): string {
  const filter = request.filter
  if (filter?.type !== 'And') throw new Error('a column sends And[query filter, column filter]')
  expect(filter.children[0]).toEqual(BASE_FILTER)
  const column = filter.children[1]
  if (column?.type !== 'Leaf' || column.primitive.type !== 'State') {
    throw new Error('not a task-state column request')
  }
  return column.primitive.is_null ? 'none' : (column.primitive.values[0] ?? '')
}

/** Answer each column's query from `byState`; a state it does not name is empty. */
function serveColumns(
  byState: Record<string, (request: AdvancedQueryRequest) => AdvancedQueryResponse>,
): void {
  mockedInvoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'batch_resolve') return [{ id: 'PAGE001', title: 'Roadmap' }]
    if (cmd !== 'run_advanced_query') throw new Error(`unexpected command ${cmd}`)
    const request = (args as { request: AdvancedQueryRequest }).request
    const answer = byState[requestedState(request)]
    return answer?.(request) ?? { rows: [], nextCursor: null, hasMore: false, totalCount: 0 }
  })
}

const page = (rows: ActiveBlockRow[], over: Partial<AdvancedQueryResponse> = {}) => ({
  rows: rows.map((r) => ({ ...r, score: null })),
  nextCursor: null,
  hasMore: false,
  totalCount: rows.length,
  ...over,
})

function renderBoard(onNavigate?: (pageId: string) => void) {
  return render(
    <QueryBoard
      columns={STATE_COLUMNS}
      filter={BASE_FILTER}
      fulltext=""
      sort={[]}
      aggregates={[]}
      onNavigate={onNavigate}
    />,
  )
}

const column = (name: string) => screen.getByRole('region', { name })
const cards = (name: string) => within(column(name)).queryAllByRole('option')

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
})

describe('QueryBoard', () => {
  it('puts each block in the column of its value, in column order, with its count', async () => {
    serveColumns({
      TODO: () => page([row('T1', { todo_state: 'TODO' }), row('T2', { todo_state: 'TODO' })]),
      DONE: () => page([row('D1', { todo_state: 'DONE' })]),
    })
    renderBoard()

    await waitFor(() => expect(cards('TODO')).toHaveLength(2))
    expect(cards('TODO').map((c) => c.getAttribute('aria-label'))).toEqual([
      'TODO card T1 Roadmap',
      'TODO card T2 Roadmap',
    ])
    expect(cards('DONE')).toHaveLength(1)
    expect(within(column('TODO')).getByTestId('query-board-column-count')).toHaveTextContent('2')
    expect(
      screen.getAllByTestId('query-board-column').map((c) => c.getAttribute('aria-label')),
    ).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED', t('advancedQuery.board.noValue')])
  })

  it('keeps a value no block has as an empty column', async () => {
    serveColumns({})
    renderBoard()

    const doing = column('DOING')
    expect(
      await within(doing).findByText(t('advancedQuery.board.emptyColumn', { column: 'DOING' })),
    ).toBeInTheDocument()
    expect(within(doing).getByTestId('query-board-column-count')).toHaveTextContent('0')
    expect(cards('DOING')).toHaveLength(0)
  })

  it('shows a skeleton while a column loads', () => {
    mockedInvoke.mockImplementation(() => new Promise(() => {}))
    renderBoard()
    expect(column('TODO').querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  })

  it('opens the page of the card that is clicked', async () => {
    serveColumns({ TODO: () => page([row('T1', { todo_state: 'TODO', page_id: 'PAGE001' })]) })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderBoard(onNavigate)

    await waitFor(() => expect(cards('TODO')).toHaveLength(1))
    await user.click(cards('TODO')[0] as HTMLElement)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('PAGE001', 'Roadmap')
  })

  it('moves within a column with the arrow keys and opens the card with Enter', async () => {
    serveColumns({
      TODO: () =>
        page([
          row('T1', { todo_state: 'TODO', page_id: 'PAGE_A' }),
          row('T2', { todo_state: 'TODO', page_id: 'PAGE_B' }),
        ]),
    })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderBoard(onNavigate)

    await waitFor(() => expect(cards('TODO')).toHaveLength(2))
    within(column('TODO')).getByRole('listbox', { name: 'TODO' }).focus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('PAGE_B', undefined)
  })

  it('loads the next page of one column from its own cursor', async () => {
    serveColumns({
      TODO: (request) =>
        request.cursor === 'CUR1'
          ? page([row('T2', { todo_state: 'TODO' })], { totalCount: null })
          : page([row('T1', { todo_state: 'TODO' })], {
              nextCursor: 'CUR1',
              hasMore: true,
              totalCount: 2,
            }),
      DONE: () => page([row('D1', { todo_state: 'DONE' })]),
    })
    const user = userEvent.setup()
    renderBoard()

    await waitFor(() => expect(cards('TODO')).toHaveLength(1))
    // Only the column with more to load offers it.
    expect(within(column('DONE')).queryByRole('button', { name: t('action.loadMore') })).toBeNull()
    await user.click(within(column('TODO')).getByRole('button', { name: t('action.loadMore') }))

    await waitFor(() => expect(cards('TODO')).toHaveLength(2))
    expect(cards('DONE')).toHaveLength(1)
    expect(within(column('TODO')).queryByRole('button', { name: t('action.loadMore') })).toBeNull()
  })

  it('shows a failed column its error and loads it on Retry, leaving the others', async () => {
    let fail = true
    serveColumns({
      TODO: () => {
        if (fail) throw new Error('engine down')
        return page([row('T1', { todo_state: 'TODO' })])
      },
      DONE: () => page([row('D1', { todo_state: 'DONE' })]),
    })
    const user = userEvent.setup()
    renderBoard()

    const alert = await within(column('TODO')).findByRole('alert')
    expect(alert).toHaveTextContent('engine down')
    expect(cards('DONE')).toHaveLength(1)

    fail = false
    await user.click(within(alert).getByRole('button', { name: t('action.retry') }))
    await waitFor(() => expect(cards('TODO')).toHaveLength(1))
    expect(within(column('TODO')).queryByRole('alert')).toBeNull()
  })

  describe('a select property', () => {
    const stage: PropertyDefinition = {
      key: 'stage',
      value_type: 'select',
      options: JSON.stringify(['later', 'now']),
      created_at: '2026-01-01T00:00:00Z',
      builtin: false,
    }
    const columns =
      boardColumns({ key: { type: 'Property', key: 'stage' } }, new Map([['stage', stage]])) ?? []
    const other = columns.find((c) => c.kind === 'other')

    function serveOther(rows: ActiveBlockRow[]): void {
      mockedInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === 'batch_resolve') return []
        const request = (args as { request: AdvancedQueryRequest }).request
        const filter = request.filter
        const mine = filter?.type === 'And' ? filter.children[1] : undefined
        return page(JSON.stringify(mine) === JSON.stringify(other?.filter) ? rows : [])
      })
    }

    const renderSelectBoard = () =>
      render(
        <QueryBoard columns={columns} filter={BASE_FILTER} fulltext="" sort={[]} aggregates={[]} />,
      )

    it('has no column for values outside the options when there are none', async () => {
      serveOther([])
      renderSelectBoard()

      await within(column('later')).findByText(
        t('advancedQuery.board.emptyColumn', { column: 'later' }),
      )
      await waitFor(() =>
        expect(
          screen.getAllByTestId('query-board-column').map((c) => c.getAttribute('aria-label')),
        ).toEqual(['later', 'now', t('advancedQuery.board.noValue')]),
      )
    })

    it('collects values outside the options in one last column', async () => {
      serveOther([row('X1')])
      renderSelectBoard()

      await waitFor(() => expect(cards(t('advancedQuery.board.other'))).toHaveLength(1))
      expect(
        screen.getAllByTestId('query-board-column').map((c) => c.getAttribute('aria-label')),
      ).toEqual(['later', 'now', t('advancedQuery.board.noValue'), t('advancedQuery.board.other')])
    })
  })

  it('has no a11y violations with cards, an empty column and a failed one', async () => {
    serveColumns({
      TODO: () => page([row('T1', { todo_state: 'TODO' })]),
      DOING: () => {
        throw new Error('engine down')
      },
    })
    const { container } = renderBoard()

    await waitFor(() => expect(cards('TODO')).toHaveLength(1))
    await within(column('DOING')).findByRole('alert')
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
