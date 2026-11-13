import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { toast } from '@/__tests__/mocks/sonner'
import { type BoardColumn, boardColumns } from '@/components/AdvancedQuery/board-columns'
import { QueryBoard } from '@/components/AdvancedQuery/QueryBoard'
import type {
  ActiveBlockRow,
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  FilterExpr,
  OpRef,
  PropertyDefinition,
  SetPropertyArgs,
} from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'
import { latestUndoEntry, useUndoStore } from '@/stores/undo'

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
const cards = (name: string) => within(column(name)).queryAllByTestId('query-board-card')

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  useUndoStore.setState({ pages: new Map() })
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
    await user.tab()
    expect(cards('TODO')[0]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(cards('TODO')[1]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('PAGE_B', undefined)
  })

  it('gives each column one Tab stop for its cursor card and one for that card’s move button', async () => {
    serveColumns({
      TODO: () => page([row('T1', { todo_state: 'TODO' }), row('T2', { todo_state: 'TODO' })]),
      DONE: () => page([row('D1', { todo_state: 'DONE' })]),
    })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderBoard(onNavigate)

    await waitFor(() => expect(cards('TODO')).toHaveLength(2))
    await waitFor(() => expect(cards('DONE')).toHaveLength(1))
    const moveButtons = (name: string) =>
      within(column(name)).getAllByRole('button', { name: t('advancedQuery.board.moveTo') })
    await user.tab()
    await user.keyboard('{ArrowDown}')
    await user.tab()
    expect(moveButtons('TODO')[1]).toHaveFocus()
    await user.tab()
    expect(cards('DONE')[0]).toHaveFocus()

    // Enter on the move button presses it: the menu opens, the card's page does not.
    await user.tab({ shift: true })
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: 'DOING' })).toBeInTheDocument()
    expect(onNavigate).not.toHaveBeenCalled()

    // An arrow key in the open menu is the menu's: the cursor stays on T2.
    await user.keyboard('{ArrowDown}{Escape}')
    await waitFor(() => expect(moveButtons('TODO')[1]).toHaveFocus())
    expect(cards('TODO').map((c) => c.tabIndex)).toEqual([-1, 0])
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

  describe('moving a card', () => {
    const stage: PropertyDefinition = {
      key: 'stage',
      value_type: 'select',
      options: JSON.stringify(['later', 'now']),
      created_at: '2026-01-01T00:00:00Z',
      builtin: false,
    }
    const STAGE_COLUMNS =
      boardColumns({ key: { type: 'Property', key: 'stage' } }, new Map([['stage', stage]])) ?? []

    /**
     * A backend small enough to re-query: each block's group value, changed by
     * the board's own write and by an undo of it, and read back by every
     * column's query. `failWrites` refuses the write.
     */
    function serveBoard(
      columns: BoardColumn[],
      values: Record<string, string | null>,
      { failWrites = false } = {},
    ): Record<string, string | null> {
      const options = new Set(columns.map((c) => c.value))
      const boardKey = columns[0]?.propertyKey ?? 'todo_state'
      const inColumn = (c: BoardColumn, value: string | null): boolean => {
        if (c.kind === 'value') return value === c.value
        return c.kind === 'none' ? value === null : value !== null && !options.has(value)
      }
      const undos = new Map<number, () => void>()
      const write = (blockId: string, value: string | null) => {
        if (failWrites) throw new Error('write refused')
        const before = values[blockId] ?? null
        const seq = undos.size + 1
        undos.set(seq, () => {
          values[blockId] = before
        })
        values[blockId] = value
        return { ...row(blockId), op_refs: [{ device_id: 'DEV', seq }] }
      }
      const undo = (ref: OpRef) => {
        undos.get(ref.seq)?.()
        return {
          reversed_op: ref,
          reversed_op_type: 'set_property',
          new_op_ref: { device_id: 'DEV', seq: ref.seq + 100 },
          new_op_type: 'set_property',
          is_redo: false,
        }
      }
      type Args = Record<string, unknown>
      const handlers: Record<string, (a: Args) => unknown> = {
        batch_resolve: () => [{ id: 'PAGE001', title: 'Roadmap' }],
        get_block: () => row('PAGE001', { block_type: 'page', content: 'Roadmap' }),
        run_advanced_query: (a) => {
          const filter = (a['request'] as AdvancedQueryRequest).filter
          const mine = JSON.stringify(filter?.type === 'And' ? filter.children[1] : null)
          const col = columns.find((c) => JSON.stringify(c.filter) === mine)
          if (!col) throw new Error('a query for no column of this board')
          return page(
            Object.keys(values)
              .filter((id) => inColumn(col, values[id] ?? null))
              .map((id) => row(id)),
          )
        },
        set_todo_state: (a) => write(a['blockId'] as string, a['state'] as string | null),
        set_property: (a) =>
          write(a['blockId'] as string, (a['value'] as SetPropertyArgs).value_text ?? null),
        delete_property: (a) => ({
          ...write(a['blockId'] as string, null),
          block_id: a['blockId'],
          key: a['key'],
        }),
        undo_op: (a) => undo(a['opRef'] as OpRef),
        undo_ops: (a) => (a['ops'] as OpRef[]).map(undo),
      }
      mockedInvoke.mockImplementation(async (cmd, args) => {
        const handler = handlers[cmd]
        if (!handler) throw new Error(`unexpected command ${cmd}`)
        const a = args as Args
        // The one write this board may make: a state board never sets a property, nor the reverse.
        const wrote = cmd === 'set_todo_state' ? 'todo_state' : (a?.['key'] as string | undefined)
        if (wrote !== undefined && wrote !== boardKey) throw new Error(`${cmd} wrote ${wrote}`)
        return handler(a)
      })
      return values
    }

    const renderColumns = (columns: BoardColumn[]) =>
      render(
        <QueryBoard columns={columns} filter={BASE_FILTER} fulltext="" sort={[]} aggregates={[]} />,
      )

    const ids = (name: string) => cards(name).map((c) => c.getAttribute('data-block-id'))

    /** Open the move menu of the first card in `from` and pick `to`. */
    async function move(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
      const moveTo = t('advancedQuery.board.moveTo')
      await user.click(within(column(from)).getAllByRole('button', { name: moveTo })[0] as Element)
      await user.click(await screen.findByRole('button', { name: to }))
    }

    const movedToast = (to: string) => {
      const call = vi
        .mocked(toast)
        .mock.calls.find(([message]) => message === t('advancedQuery.board.moved', { column: to }))
      if (!call) throw new Error(`no "moved to ${to}" toast`)
      return call[1] as { action: { label: string; onClick: () => void } }
    }

    it('offers every other column except “Other values”, and not the card’s own', async () => {
      serveBoard(STAGE_COLUMNS, { B1: 'later', X1: 'stale' })
      const user = userEvent.setup()
      renderColumns(STAGE_COLUMNS)

      await waitFor(() => expect(ids('later')).toEqual(['B1']))
      await user.click(
        within(column('later')).getByRole('button', { name: t('advancedQuery.board.moveTo') }),
      )
      const menu = await screen.findByRole('dialog', { name: t('advancedQuery.board.moveTo') })
      expect(
        within(menu)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['now', t('advancedQuery.board.noValue')])
    })

    it('moves a card on a state board and shows it in the column it went to', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO', T2: 'TODO', D1: 'DONE' })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1', 'T2']))
      await move(user, 'TODO', 'DONE')

      await waitFor(() => expect(ids('DONE')).toEqual(['T1', 'D1']))
      expect(ids('TODO')).toEqual(['T2'])
      expect(values).toEqual({ T1: 'DONE', T2: 'TODO', D1: 'DONE' })
      expect(movedToast('DONE').action.label).toBe(t('action.undo'))
      // The card is gone from under the focus; the column it left takes it.
      expect(column('TODO')).toHaveFocus()
    })

    it('clears the state when a card moves to “No value”', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO' })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      await move(user, 'TODO', t('advancedQuery.board.noValue'))

      await waitFor(() => expect(ids(t('advancedQuery.board.noValue'))).toEqual(['T1']))
      expect(values).toEqual({ T1: null })
    })

    it('sets, clears and replaces a select value, out of “Other values” too', async () => {
      const values = serveBoard(STAGE_COLUMNS, { B1: 'later', X1: 'stale' })
      const user = userEvent.setup()
      renderColumns(STAGE_COLUMNS)
      const none = t('advancedQuery.board.noValue')

      await waitFor(() => expect(ids('later')).toEqual(['B1']))
      await move(user, 'later', 'now')
      await waitFor(() => expect(ids('now')).toEqual(['B1']))

      await move(user, 'now', none)
      await waitFor(() => expect(ids(none)).toEqual(['B1']))
      expect(values['B1']).toBeNull()

      await move(user, t('advancedQuery.board.other'), 'later')
      await waitFor(() => expect(ids('later')).toEqual(['X1']))
      // "Other values" is gone with its last card; the focus went with the card.
      expect(column('later')).toHaveFocus()
      expect(values).toEqual({ B1: null, X1: 'later' })
    })

    it('takes the move back from the toast’s Undo', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO' })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      // An earlier change to the page, which the page can still undo afterwards.
      const earlier = [{ device_id: 'DEV', seq: 900 }]
      useUndoStore.getState().onNewAction('PAGE001', earlier)
      await move(user, 'TODO', 'DOING')
      await waitFor(() => expect(ids('DOING')).toEqual(['T1']))

      movedToast('DOING').action.onClick()
      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      expect(ids('DOING')).toEqual([])
      expect(values).toEqual({ T1: 'TODO' })
      expect(latestUndoEntry('PAGE001')?.refs).toEqual(earlier)
    })

    it('puts the move on its page’s undo stack, so the page’s own undo takes it back', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO' })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      await move(user, 'TODO', 'DOING')
      await waitFor(() => expect(values).toEqual({ T1: 'DOING' }))

      await useUndoStore.getState().undo('PAGE001')
      expect(values).toEqual({ T1: 'TODO' })
    })

    it('still takes the move back from the toast after a later change to the page', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO', T2: 'TODO' })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1', 'T2']))
      await move(user, 'TODO', 'DOING')
      await waitFor(() => expect(ids('DOING')).toEqual(['T1']))
      await move(user, 'TODO', 'DONE')
      await waitFor(() => expect(ids('DONE')).toEqual(['T2']))

      // T1's move is no longer the page's latest entry; its toast reverses it alone.
      movedToast('DOING').action.onClick()
      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      expect(values).toEqual({ T1: 'TODO', T2: 'DONE' })
      // The reversal is an op the page's stack does not hold: the stack starts over.
      expect(latestUndoEntry('PAGE001')).toBeUndefined()
    })

    it('leaves the card where it was and says so when the write is refused', async () => {
      const values = serveBoard(STATE_COLUMNS, { T1: 'TODO' }, { failWrites: true })
      const user = userEvent.setup()
      renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      await move(user, 'TODO', 'DONE')

      await waitFor(() =>
        expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
          t('advancedQuery.board.moveFailed'),
        ),
      )
      expect(ids('TODO')).toEqual(['T1'])
      expect(values).toEqual({ T1: 'TODO' })
      expect(latestUndoEntry('PAGE001')).toBeUndefined()
    })

    it('has no a11y violations with the move menu open', async () => {
      serveBoard(STATE_COLUMNS, { T1: 'TODO' })
      const user = userEvent.setup()
      const { baseElement } = renderColumns(STATE_COLUMNS)

      await waitFor(() => expect(ids('TODO')).toEqual(['T1']))
      await user.click(
        within(column('TODO')).getByRole('button', { name: t('advancedQuery.board.moveTo') }),
      )
      await screen.findByRole('dialog', { name: t('advancedQuery.board.moveTo') })
      await waitFor(async () => {
        expect(await axe(baseElement)).toHaveNoViolations()
      })
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
