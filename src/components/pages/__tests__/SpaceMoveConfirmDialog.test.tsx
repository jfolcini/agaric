/**
 * SpaceMoveConfirmDialog + useSpaceMove over the tauri mock (#5841 S0.6).
 *
 * The cross-space move's confirmation: a move that drops properties asks
 * first, lists each with its count, expands to the blocks holding the values,
 * and moves only once confirmed; a refused acknowledgement asks again. Every
 * IPC goes through the mock's real handlers, and the assertions read the
 * mock's state back rather than the calls made.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SpaceMoveConfirmDialog } from '@/components/pages/SpaceMoveConfirmDialog'
import { useSpaceMove } from '@/hooks/useSpaceMove'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  spacePropertyDefs,
} from '@/lib/tauri-mock/seed'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const SPACE_A = '01SPACEA000000000000000001'
const SPACE_B = '01SPACEB000000000000000001'
const PAGE = '00000000000000000000PAGE01'
const CHILD = '0000000000000000000BLOCK01'
const TRASHED = '0000000000000000000BLOCK02'

function row(blockId: string, key: string, value: Record<string, unknown>) {
  return {
    block_id: blockId,
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...value,
  }
}

function seedSpace(id: string, name: string): void {
  blocks.set(id, makeBlock(id, 'page', name, null, 1))
  properties.set(id, new Map([['is_space', row(id, 'is_space', { value_text: 'true' })]]))
}

/**
 * A page in A with a child and a trashed child. A declares `stage` as a
 * select; B declares it with another option, and `due` only in B. `note` is
 * declared nowhere and stays.
 */
function seedMove(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
  seedSpace(SPACE_A, 'Space A')
  seedSpace(SPACE_B, 'Space B')
  spacePropertyDefs(SPACE_A).set('stage', {
    key: 'stage',
    value_type: 'select',
    options: '["draft","final"]',
    created_at: '2026-01-01T00:00:00.000Z',
  })
  spacePropertyDefs(SPACE_B).set('stage', {
    key: 'stage',
    value_type: 'select',
    options: '["draft","final","archived"]',
    created_at: '2026-01-01T00:00:00.000Z',
  })
  spacePropertyDefs(SPACE_B).set('due', {
    key: 'due',
    value_type: 'text',
    options: null,
    created_at: '2026-01-01T00:00:00.000Z',
  })
  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Plan', null, 1))
  blocks.set(CHILD, makeBlock(CHILD, 'content', 'card', PAGE, 1))
  const trashed = makeBlock(TRASHED, 'content', 'old', PAGE, 2)
  trashed['deleted_at'] = 1_700_000_000_000
  blocks.set(TRASHED, trashed)
  properties.set(
    PAGE,
    new Map([
      ['space', row(PAGE, 'space', { value_ref: SPACE_A })],
      ['stage', row(PAGE, 'stage', { value_text: 'draft' })],
      ['note', row(PAGE, 'note', { value_text: 'keep' })],
    ]),
  )
  properties.set(CHILD, new Map([['due', row(CHILD, 'due', { value_text: 'friday' })]]))
  properties.set(TRASHED, new Map([['stage', row(TRASHED, 'stage', { value_text: 'final' })]]))
}

function keysOf(blockId: string): string[] {
  return [...(properties.get(blockId)?.keys() ?? [])].toSorted()
}

const onMoved = vi.fn()
const onFailed = vi.fn()

function Harness(): React.ReactElement {
  const move = useSpaceMove()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void move.requestMove({
            ids: [PAGE],
            targetSpaceId: SPACE_B,
            targetName: 'Space B',
            onMoved,
            onFailed,
          })
        }}
      >
        Move
      </button>
      <SpaceMoveConfirmDialog
        confirmation={move.confirmation}
        onConfirm={move.confirm}
        onDismiss={move.dismiss}
      />
    </>
  )
}

async function openConfirmation(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Move' }))
  return screen.findByRole('alertdialog')
}

beforeEach(() => {
  vi.clearAllMocks()
  seedMove()
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

describe('SpaceMoveConfirmDialog', () => {
  it('lists each property the move drops with its count, and moves only on confirm', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openConfirmation(user)

    const list = within(dialog).getByRole('list', { name: t('spaceMove.lossListLabel') })
    const rows = within(list)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(rows).toEqual(['due1 value', 'stage2 values'])
    // Asked once, from the preview: nothing changed since.
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    // Nothing moved while the dialog asks.
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_A)
    expect(keysOf(PAGE)).toEqual(['note', 'space', 'stage'])

    await user.click(within(dialog).getByRole('button', { name: t('spaceMove.lossConfirm') }))

    await waitFor(() => {
      expect(onMoved).toHaveBeenCalledWith(1)
    })
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_B)
    expect(keysOf(PAGE)).toEqual(['note', 'space'])
    expect(keysOf(CHILD)).toEqual([])
    expect(keysOf(TRASHED)).toEqual([])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('expands a property to the pages and blocks holding its values', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openConfirmation(user)

    const stage = within(dialog).getByRole('button', { name: /^stage/ })
    expect(stage).toHaveAttribute('aria-expanded', 'false')
    await user.click(stage)
    expect(stage).toHaveAttribute('aria-expanded', 'true')

    const values = await within(dialog).findByText('Plan › old')
    const holders = within(values.closest('ul') as HTMLElement).getAllByRole('listitem')
    expect(holders.map((item) => item.textContent)).toEqual([
      'Plandraft',
      `Plan › old${t('spaceMove.inTrash')}final`,
    ])
  })

  it('shows a reference value as the title of the block it points at', async () => {
    const user = userEvent.setup()
    useSpaceStore.setState({ currentSpaceId: SPACE_A })
    properties.get(CHILD)?.set('due', row(CHILD, 'due', { value_ref: PAGE }))
    render(<Harness />)
    const dialog = await openConfirmation(user)

    await user.click(within(dialog).getByRole('button', { name: /^due/ }))

    const holder = await within(dialog).findByText('Plan › card')
    expect(holder.closest('li')).toHaveTextContent(/^Plan › cardPlan$/)
  })

  it('lists the holders a page at a time, and Load more brings the rest', async () => {
    const user = userEvent.setup()
    // 60 more blocks of the page hold `stage`: 62 values in all, past one page.
    for (let i = 0; i < 60; i++) {
      const id = `${'0'.repeat(19)}H${String(i).padStart(6, '0')}`
      blocks.set(id, makeBlock(id, 'content', `holder ${i}`, PAGE, 3 + i))
      properties.set(id, new Map([['stage', row(id, 'stage', { value_text: 'draft' })]]))
    }
    render(<Harness />)
    const dialog = await openConfirmation(user)

    const stage = within(dialog).getByRole('button', { name: /^stage/ })
    await user.click(stage)
    const holders = document.getElementById(
      stage.getAttribute('aria-controls') ?? '',
    ) as HTMLElement
    await waitFor(() => {
      expect(within(holders).getAllByRole('listitem')).toHaveLength(50)
    })

    await user.click(within(holders).getByRole('button', { name: t('action.loadMore') }))

    await waitFor(() => {
      expect(within(holders).getAllByRole('listitem')).toHaveLength(62)
    })
    expect(
      within(holders).queryByRole('button', { name: t('action.loadMore') }),
    ).not.toBeInTheDocument()
  })

  it('moves straight through when nothing would be lost', async () => {
    const user = userEvent.setup()
    properties.get(PAGE)?.delete('stage')
    properties.get(CHILD)?.delete('due')
    properties.get(TRASHED)?.delete('stage')
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Move' }))

    await waitFor(() => {
      expect(onMoved).toHaveBeenCalledWith(1)
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_B)
    expect(keysOf(PAGE)).toEqual(['note', 'space'])
  })

  it('asks again with the new losses when the acknowledgement went stale', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openConfirmation(user)
    // Another write lands between the preview and the confirm.
    properties.get(CHILD)?.set('stage', row(CHILD, 'stage', { value_text: 'draft' }))

    await user.click(within(dialog).getByRole('button', { name: t('spaceMove.lossConfirm') }))

    expect(await within(dialog).findByRole('status')).toHaveTextContent(t('spaceMove.lossChanged'))
    const list = within(dialog).getByRole('list', { name: t('spaceMove.lossListLabel') })
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['due1 value', 'stage3 values'])
    expect(onMoved).not.toHaveBeenCalled()
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_A)

    await user.click(within(dialog).getByRole('button', { name: t('spaceMove.lossConfirm') }))

    await waitFor(() => {
      expect(onMoved).toHaveBeenCalledWith(1)
    })
    expect(keysOf(CHILD)).toEqual([])
  })

  it('asks without saying anything changed when a move that needed no confirmation turns lossy', async () => {
    const user = userEvent.setup()
    properties.get(PAGE)?.delete('stage')
    properties.get(CHILD)?.delete('due')
    properties.get(TRASHED)?.delete('stage')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      // Another write lands between the lossless preview and the move.
      if (cmd === 'move_blocks_to_space' && !properties.get(CHILD)?.has('stage')) {
        properties.get(CHILD)?.set('stage', row(CHILD, 'stage', { value_text: 'draft' }))
      }
      return dispatch(cmd, args)
    })
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Move' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(onMoved).not.toHaveBeenCalled()
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_A)
  })

  it('cancel leaves the page and its values where they were', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openConfirmation(user)

    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(onMoved).not.toHaveBeenCalled()
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_A)
    expect(keysOf(PAGE)).toEqual(['note', 'space', 'stage'])
  })

  it('hands a failed preview to the caller and opens nothing', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'preview_space_move') throw new Error('preview failed')
      return dispatch(cmd, args)
    })
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Move' }))

    await waitFor(() => {
      expect(onFailed).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(properties.get(PAGE)?.get('space')?.['value_ref']).toBe(SPACE_A)
  })

  it('shows an error in place of the values when they fail to load', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'list_property_loss_values') throw new Error('load failed')
      return dispatch(cmd, args)
    })
    render(<Harness />)
    const dialog = await openConfirmation(user)

    await user.click(within(dialog).getByRole('button', { name: /^stage/ }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(t('spaceMove.valuesFailed'))
  })

  it('has no a11y violations, collapsed and expanded', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await openConfirmation(user)
    expect(await axe(dialog)).toHaveNoViolations()

    await user.click(within(dialog).getByRole('button', { name: /^stage/ }))
    await within(dialog).findByText('Plan › old')
    expect(await axe(dialog)).toHaveNoViolations()
  })
})
