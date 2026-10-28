/**
 * Block mode's toolbar in page mode (#5691, `page-toolbar.tsx`): it renders
 * without Discard, sticky, and its block commands reach page mode's own
 * actions through the bus: Turn into on every block the selection touches,
 * the task button setting or clearing TODO, the rest on the caret's block.
 * Turn into shows the caret block's list style. Nothing here calls IPC: the
 * actions do, and their refusals are tested where they live (`page-lists`,
 * `PageBlockMenu`).
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/core'
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { setActiveEditor } from '@/editor/active-editor'
import {
  blockId,
  caret,
  idMinter,
  openPage,
  PAGE,
  posIn,
  type Row,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { listSource } from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { PageLists } from '@/editor/page-mode/page-lists'
import { PageToolbar, type PageToolbarActions } from '@/editor/page-mode/page-toolbar'
import { t } from '@/lib/i18n'
import { __resetBlockCommandBus } from '@/stores/block-command-bus'
import { useBlockStore } from '@/stores/blocks'
import { createPageBlockStore } from '@/stores/page-blocks'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const ROWS: Row[] = [
  [A, 0, 'alpha'],
  [B, 0, 'beta'],
  [C, 0, 'gamma'],
]

let editor: Editor | null = null

afterEach(() => {
  setActiveEditor(null)
  __resetBlockCommandBus()
  useBlockStore.setState({ focusedBlockId: null })
  editor?.destroy()
  editor = null
})

function mount(todo: Record<string, string> = {}) {
  const lists = new PageLists(
    {},
    ROWS.map(([id, depth]) => ({ id, depth })),
  )
  editor = openPage(ROWS, idMinter(), undefined, listSource(lists))
  const pageStore = createPageBlockStore(PAGE)
  pageStore.setState({
    blocks: ROWS.map(([id]) => makeBlock({ id, todo_state: todo[id] ?? null })),
  })
  const actions: { current: PageToolbarActions } = {
    current: {
      setTodo: vi.fn(),
      setListStyle: vi.fn(),
      cyclePriority: vi.fn(),
      openDatePicker: vi.fn(),
      openDateLinkPicker: vi.fn(),
      openPropertyDrawer: vi.fn(),
      turnInto: vi.fn(),
      command: vi.fn(),
    },
  }
  setActiveEditor(editor as unknown as Parameters<typeof setActiveEditor>[0])
  const view = render(
    <PageToolbar
      editor={editor as unknown as React.ComponentProps<typeof PageToolbar>['editor']}
      actions={actions}
      lists={lists}
      pageStore={pageStore}
    />,
  )
  return { ...view, actions: actions.current, lists, editor }
}

const press = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0 })
const button = (name: string) => screen.getByRole('button', { name })

/** Select from the start of block `from` to the end of block `to`. */
function select(ed: Editor, from: number, to: number): void {
  act(() => {
    const end = ed.state.doc.child(to).textContent.length
    ed.commands.setTextSelection({ from: posIn(ed, from, 0), to: posIn(ed, to, end) })
  })
}

function turnInto(name: string): void {
  press(button(t('toolbar.turnInto')))
  press(
    within(screen.getByRole('menu', { name: t('toolbar.turnInto') })).getByRole('menuitemradio', {
      name,
    }),
  )
}

describe('PageToolbar', () => {
  it('is block mode toolbar, sticky, without Discard, with no axe violations', async () => {
    const { container } = mount()
    const bar = screen.getByTestId('formatting-toolbar')
    expect(bar.className).toContain('sticky')
    expect(screen.queryByRole('button', { name: t('toolbar.discard') })).toBeNull()
    expect(button(t('toolbar.undo'))).toBeTruthy()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Turn into runs on every block the selection touches', () => {
    const { actions, editor: ed } = mount()
    select(ed, 0, 1)
    turnInto(t('contextMenu.turnIntoType.h1'))
    expect(vi.mocked(actions.turnInto).mock.calls.map(([id, item]) => [id, item.id])).toEqual([
      [A, 'turn-h1'],
      [B, 'turn-h1'],
    ])
  })

  it('Turn into shows the caret block list style', () => {
    const { lists, editor: ed } = mount()
    act(() => {
      lists.settle(B, lists.want(B, 'bullet'), 'bullet')
      caret(ed, 1, 2)
    })
    press(button(t('toolbar.turnInto')))
    const bullet = screen.getByRole('menuitemradio', {
      name: t('contextMenu.turnIntoType.bulletList'),
    })
    expect(bullet.getAttribute('aria-checked')).toBe('true')
  })

  it('Turn into code takes the list style off every block the selection touches', () => {
    const { actions, editor: ed } = mount()
    select(ed, 0, 1)
    press(button(t('toolbar.turnInto')))
    press(screen.getByRole('menuitem', { name: t('contextMenu.turnIntoType.code') }))
    press(button('javascript'))
    expect(ed.state.doc.child(0).firstChild?.type.name).toBe('codeBlock')
    expect(vi.mocked(actions.setListStyle).mock.calls).toEqual([
      [A, 'none'],
      [B, 'none'],
    ])
  })

  it('the task button says it sets or clears TODO, as Ctrl+Enter cycles the task here', async () => {
    mount()
    await userEvent.setup().hover(button(t('toolbar.todoToggle')))
    expect(await screen.findByRole('tooltip', { name: t('pageMode.todoToggleTip') })).toBeTruthy()
  })

  it('the task button sets TODO on the selected blocks, and clears it once all are tasks', () => {
    const first = mount({ [A]: 'DONE' })
    select(first.editor, 0, 1)
    press(button(t('toolbar.todoToggle')))
    expect(first.actions.setTodo).toHaveBeenCalledWith([A, B], 'TODO')
    first.unmount()
    editor?.destroy()

    const second = mount({ [A]: 'DONE', [B]: 'TODO' })
    select(second.editor, 0, 1)
    press(button(t('toolbar.todoToggle')))
    expect(second.actions.setTodo).toHaveBeenCalledWith([A, B], null)
  })

  it('priority, properties and the due date act on the caret block', () => {
    const { actions, editor: ed } = mount()
    act(() => caret(ed, 2, 1))
    press(button(t('toolbar.cyclePriority')))
    press(button(t('toolbar.properties')))
    press(button(t('toolbar.setDueDate')))
    expect(actions.cyclePriority).toHaveBeenCalledWith(C)
    expect(actions.openPropertyDrawer).toHaveBeenCalledWith(C)
    expect(actions.openDatePicker).toHaveBeenCalledWith(C, 'due')
  })

  it('leaves the commands to block mode while another editor is in use', () => {
    const { actions } = mount()
    setActiveEditor(null)
    press(button(t('toolbar.cyclePriority')))
    expect(actions.cyclePriority).not.toHaveBeenCalled()
  })
})
