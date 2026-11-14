/**
 * A query table's cells edit their block (#6743), against the mock backend's
 * seed: "Weekly standup notes" holds context=@office and project=alpha, and
 * "Design review feedback" context=@remote and project=beta. `project` is a
 * select of alpha, beta and gamma; `context` is text.
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlock, makePropertyRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { answerInvokeFromMock, stubInvoke } from '@/__tests__/helpers/invoke'
import { QueryResult } from '@/components/query/QueryResult'
import { QueryResultTable, type TableColumn } from '@/components/query/QueryResultTable'
import type { PropertyDefinition } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { SEED_IDS } from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'
import { latestUndoEntry, useUndoStore } from '@/stores/undo'

const mockedInvoke = vi.mocked(invoke)

const QUERY = 'type:property key:project table:true'
const WRITES = new Set(['set_property', 'delete_property', 'set_todo_state'])

/** The write commands the test has sent so far, in order. */
function writes(): string[] {
  return mockedInvoke.mock.calls.map(([cmd]) => cmd).filter((cmd) => WRITES.has(cmd))
}

function editCell(column: string, value: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: t('queryResult.cell.edit', { column, value }) })
}

function row(content: string): HTMLElement {
  return screen.getByRole('button', { name: content }).closest('tr') as HTMLElement
}

beforeEach(async () => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_PERSONAL' })
  useUndoStore.setState({ pages: new Map() })
  await answerInvokeFromMock(mockedInvoke)
})

describe('a query table cell against the mock backend', () => {
  it('writes a picked option once, shows it after the refetch, and offers Undo', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)

    await user.click(await editCell('project', 'alpha'))
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('pageProperty.valueLabel', { key: 'project' }) }),
      'gamma',
    )

    expect(await editCell('project', 'gamma')).toBeInTheDocument()
    expect(writes()).toEqual(['set_property'])
    expect(latestUndoEntry(SEED_IDS.PAGE_MEETINGS)).toBeDefined()
    expect(toast).toHaveBeenCalledWith(
      t('queryResult.cell.updated', { column: 'project' }),
      expect.objectContaining({ action: expect.objectContaining({ label: t('action.undo') }) }),
    )

    const [, options] = vi.mocked(toast).mock.calls.at(-1) as unknown as [
      string,
      { action: { onClick: () => void } },
    ]
    options.action.onClick()
    expect(await editCell('project', 'alpha')).toBeInTheDocument()
  })

  it('opens on Enter, saves a typed text value, and gives the cell its focus back', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)

    ;(await editCell('context', '@office')).focus()
    await user.keyboard('{Enter}')
    const input = screen.getByRole('textbox', {
      name: t('pageProperty.valueLabel', { key: 'context' }),
    })
    expect(input).toHaveFocus()
    await user.clear(input)
    await user.keyboard('@home{Enter}')

    const cell = await editCell('context', '@home')
    await waitFor(() => expect(cell).toHaveFocus())
    expect(writes()).toEqual(['set_property'])
  })

  it('leaves the value alone on Escape', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)

    await user.click(await editCell('context', '@office'))
    await user.keyboard('changed{Escape}')

    const cell = await editCell('context', '@office')
    await waitFor(() => expect(cell).toHaveFocus())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(writes()).toEqual([])
  })

  it('closes an untouched text cell that loses focus, and writes nothing', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)

    await user.click(await editCell('context', '@office'))
    await user.click(screen.getByRole('button', { name: 'Design review feedback' }))

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(writes()).toEqual([])
  })

  it('removes the property when its value is cleared', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={`${QUERY} columns:project,context`} />)

    await user.click(await editCell('context', '@office'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(
        within(row('Weekly standup notes')).getByRole('button', {
          name: t('queryResult.cell.set', { column: 'context' }),
        }),
      ).toBeInTheDocument(),
    )
    expect(writes()).toEqual(['delete_property'])
  })

  it('sets a task state through set_todo_state', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)
    await editCell('project', 'alpha')

    const status = t('query.column.status')
    await user.click(
      within(row('Weekly standup notes')).getByRole('button', {
        name: t('queryResult.cell.set', { column: status }),
      }),
    )
    await user.selectOptions(screen.getByRole('combobox'), 'DOING')

    expect(await editCell(status, 'DOING')).toBeInTheDocument()
    expect(writes()).toEqual(['set_todo_state'])
  })

  it('sets a built-in date column through set_property', async () => {
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)
    await editCell('project', 'alpha')

    const due = t('query.column.dueDate')
    await user.click(
      within(row('Weekly standup notes')).getByRole('button', {
        name: t('queryResult.cell.set', { column: due }),
      }),
    )
    await user.keyboard('2026-12-01{Enter}')

    expect(await editCell(due, '2026-12-01')).toBeInTheDocument()
    expect(writes()).toEqual(['set_property'])
  })

  it('writes the page a ref cell picks', async () => {
    await invoke('create_property_def', {
      spaceId: 'SPACE_PERSONAL',
      key: 'owner',
      valueType: 'ref',
      options: null,
    })
    const user = userEvent.setup()
    render(<QueryResult expression={`${QUERY} columns:owner`} />)

    await user.click(
      within(await screen.findByRole('table')).getAllByRole('button', {
        name: t('queryResult.cell.set', { column: 'owner' }),
      })[0] as HTMLElement,
    )
    await user.click(await screen.findByRole('button', { name: 'Getting Started' }))

    expect(await editCell('owner', SEED_IDS.PAGE_GETTING_STARTED)).toBeInTheDocument()
    expect(writes()).toEqual(['set_property'])
    expect(toast).toHaveBeenCalledWith(
      t('queryResult.cell.updated', { column: 'owner' }),
      expect.objectContaining({ action: expect.anything() }),
    )
  })

  it('shows an error toast and keeps the value when the write is rejected', async () => {
    const answer = mockedInvoke.getMockImplementation()
    if (!answer) throw new Error('answerInvokeFromMock set no implementation')
    mockedInvoke.mockImplementation((cmd, args) =>
      cmd === 'set_property' ? Promise.reject(new Error('disk full')) : answer(cmd, args),
    )
    const user = userEvent.setup()
    render(<QueryResult expression={QUERY} />)

    await user.click(await editCell('project', 'alpha'))
    await user.selectOptions(screen.getByRole('combobox'), 'gamma')

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('property.saveFailed')))
    expect(await editCell('project', 'alpha')).toBeInTheDocument()
    expect(toast).not.toHaveBeenCalled()
  })

  it('has no a11y violations with a text cell open, or a select cell', async () => {
    const user = userEvent.setup()
    const { container } = render(<QueryResult expression={QUERY} />)

    await user.click(await editCell('context', '@office'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()

    await user.keyboard('{Escape}')
    await user.click(await editCell('project', 'alpha'))
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('leaves the arrow keys alone while no cell is open', async () => {
    render(<QueryResult expression={QUERY} />)
    const cell = await editCell('context', '@office')
    cell.focus()

    // `fireEvent` answers whether the event went unprevented.
    expect(fireEvent.keyDown(cell, { key: 'ArrowDown' })).toBe(true)
    expect(fireEvent.keyDown(cell, { key: 'ArrowUp' })).toBe(true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(cell).toHaveFocus()
  })
})

describe('a query table cell and its definition', () => {
  const columns: TableColumn[] = [
    { key: 'content', label: 'Content' },
    { key: 'prop:estimate', label: 'estimate', propKey: 'estimate' },
    { key: 'prop:created_at', label: 'created_at', propKey: 'created_at' },
  ]
  const estimate: PropertyDefinition = {
    key: 'estimate',
    value_type: 'number',
    options: null,
    created_at: '2026-01-01T00:00:00.000Z',
    builtin: false,
  }

  function renderTable(): void {
    stubInvoke(mockedInvoke, {
      list_property_defs: () => ({
        items: [estimate],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
    })
    render(
      <QueryResultTable
        results={[makeBlock({ id: 'B1', content: 'Row one', page_id: 'P1' })]}
        columns={columns}
        pageTitles={new Map()}
        sortKey={null}
        sortDir="asc"
        onColumnSort={vi.fn()}
        customProps={new Map([['B1', new Map([['estimate', 'soon']])]])}
        propertyRows={{ B1: [makePropertyRow({ key: 'estimate', value_text: 'soon' })] }}
      />,
    )
  }

  it('shows the drawer’s error for a value the definition refuses, and writes nothing', async () => {
    const user = userEvent.setup()
    renderTable()

    await user.click(await editCell('estimate', 'soon'))
    await user.keyboard('er{Enter}')

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('property.invalidNumber')))
    expect(writes()).toEqual([])
  })

  it('does not edit a key the app manages', async () => {
    renderTable()
    await editCell('estimate', 'soon')

    expect(
      screen.queryByRole('button', { name: t('queryResult.cell.set', { column: 'created_at' }) }),
    ).not.toBeInTheDocument()
  })
})
