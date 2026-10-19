/**
 * Page mode's node view and task keys (#5743, #5915), driven without
 * `PageModeEditor`: what each block draws from the page store beside its text,
 * what its controls and keys ask for, and a typed task marker's commit. The
 * controls' commands are `PageModeEditor`'s and are tested there; here the
 * page store is `FakeTasks`, whose actions change what it holds, so a test
 * reads back what the view then draws. The marker, query and attachment parts
 * of the view are drawn here too; what they draw is tested beside their modules
 * (`page-lists`, `page-rendered`, `page-attachments`).
 *
 * Equivalent mutants, accepted:
 * - Every `id === null` test in the view (`watch` and its reveal, the
 *   constructor, `show`, `showState`, `showRendered`, `showMetadata`), and the
 *   `?.` on a checkbox only a null id leaves unset: a block's view never holds
 *   a null id, as the id rules mint one in the transaction that makes the block.
 * - The keys extension's name: nothing looks it up.
 * - `waiting.delete` in `unwatch`, and `mount`'s `renderer !== null` guard:
 *   either alone mounts a view's controls once.
 * - `dom instanceof Element` in the gate's `reveal`: no other node is watched.
 * - `node.type !== this.node.type` → `false` in `update`: only page blocks
 *   get this view.
 * - `$head.depth >= 1` → `true` in the caret's reveal: at depth 0, `before(1)`
 *   is the selection's own position, the page's end or the start of the block
 *   after a selected one, which then mounts its controls early, as drawn on
 *   scrolling to it.
 * - `first?.` in `leadingTask`: a page block holds at least one child.
 * - `commitPageTask`'s bail (`saved === undefined || node === null || task ===
 *   null`), each test dropped or joined: no saved entry leaves no node, and
 *   no node no task.
 * - `return true` → `false` in the commit's edit: `commitPageTask` ignores
 *   what `commitCheckboxState` resolves.
 */

import type { InvokeArgs } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, within } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { AllSelection, NodeSelection } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { MockIntersectionObserver } from '@/__tests__/helpers/viewport-observer-mocks'
import {
  blockId,
  caret,
  FakeBackend,
  openPage,
  posIn,
  press,
  type Row,
  rowsOf,
  treeRows,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import {
  blockEl,
  FakeTasks,
  findIn,
  mountNodeViews,
  SCOPE,
  seedPage,
  settle,
} from '@/editor/page-mode/__tests__/page-node-view-fixtures'
import { REMOTE_PATCH } from '@/editor/page-mode/page-document'
import { PageLists } from '@/editor/page-mode/page-lists'
import { RENDERED } from '@/editor/page-mode/page-rendered'
import { createSaveState } from '@/editor/page-mode/page-save'
import { commitPageTask, leadingTask } from '@/editor/page-mode/page-tasks'
import type { BlockRow, PropertyRow } from '@/lib/bindings'
import { formatCompactDate } from '@/lib/date-utils'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { seedBlocks } from '@/lib/tauri-mock/seed'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)

const MARKER = '[data-testid="task-marker"]'
const BADGE = '[data-testid="priority-badge"]'
const ROW = '.page-block-metadata'

let teardown: (() => void) | null = null

function mount(rows: readonly Row[], tasks = new FakeTasks()) {
  const mounted = mountNodeViews(rows, tasks)
  teardown = () => {
    mounted.unmount()
    mounted.editor.destroy()
  }
  return mounted
}

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  // A runtime without the observer mounts every block's controls at once.
  vi.stubGlobal('IntersectionObserver', undefined)
})

afterEach(() => {
  teardown?.()
  teardown = null
  vi.unstubAllGlobals()
})

function pressIn(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  let taken = false
  act(() => {
    taken = press(editor, key, init)
  })
  return taken
}

/** Where the horizontal rule after block `index`'s first paragraph starts. */
function ruleIn(editor: Editor, index: number): number {
  return posIn(editor, index, 0) - 1 + editor.state.doc.child(index).child(0).nodeSize
}

/** The backend for a preview's byte read, and nothing else. */
const readsAttachmentBytes = (cmd: string): Promise<unknown> =>
  cmd === 'read_attachment' ? Promise.resolve([104, 105]) : strictInvokeFallback(cmd)

const listStyle = (value: string): PropertyRow[] => [
  {
    key: 'listStyle',
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  },
]

function attachmentOf(id: string) {
  return {
    id: `ATT${id}`,
    block_id: id,
    mime_type: 'text/plain',
    filename: 'notes.txt',
    size_bytes: 2,
    fs_path: 'notes.txt',
    created_at: 0,
    content_hash: '',
  }
}

describe('the checkbox', () => {
  it('draws block mode’s checkbox before a task’s text, outside it, with no a11y violations', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'TODO' })
    const { container } = mount(
      [
        [A, 0, 'buy milk'],
        [B, 0, 'plain'],
      ],
      tasks,
    )

    const block = blockEl(container, A)
    const checkbox = await findIn(block, MARKER)
    expect(checkbox.getAttribute('aria-label')).toBe(t('block.taskCycle', { state: 'TODO' }))
    expect(block).toHaveAttribute('data-todo-state', 'TODO')
    expect(block).toHaveAttribute('data-page-block', '')
    expect(block).toHaveAttribute('data-depth', '0')
    expect(block.firstElementChild).toHaveClass('page-block-controls')
    expect((block.firstElementChild as HTMLElement).contentEditable).toBe('false')
    expect(block.querySelector('.page-block-content')?.contains(checkbox)).toBe(false)
    expect(blockEl(container, B).querySelector(MARKER)).toBeNull()
    expect(blockEl(container, B)).not.toHaveAttribute('data-todo-state')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('a click cycles the state, and the checkbox shows what the store then holds', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'TODO' })
    const { container, editor } = mount([[A, 0, 'buy milk']], tasks)

    fireEvent.click(await findIn(blockEl(container, A), MARKER))

    expect(tasks.cycle).toHaveBeenCalledWith(A)
    await settle()
    expect(blockEl(container, A).querySelector(MARKER)?.getAttribute('aria-label')).toBe(
      t('block.taskCycle', { state: 'DOING' }),
    )
    expect(blockEl(container, A)).toHaveAttribute('data-todo-state', 'DOING')
    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, 'buy milk']])
  })

  it('a state the store clears takes the checkbox off; one it sets again brings it back', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'DONE' })
    const { container } = mount([[A, 0, 'buy milk']], tasks)
    await findIn(blockEl(container, A), MARKER)

    act(() => tasks.setBlock(A, { todo_state: null }))
    expect(blockEl(container, A).querySelector('.page-block-controls')).toBeNull()
    expect(blockEl(container, A)).not.toHaveAttribute('data-todo-state')

    act(() => tasks.setBlock(A, { todo_state: 'TODO' }))
    expect(blockEl(container, A).querySelectorAll('.page-block-controls')).toHaveLength(1)
    expect((await findIn(blockEl(container, A), MARKER)).getAttribute('aria-label')).toBe(
      t('block.taskCycle', { state: 'TODO' }),
    )
  })

  it('Ctrl+Enter cycles the caret’s block, which shows its checkbox', async () => {
    const tasks = new FakeTasks()
    const { container, editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )

    act(() => caret(editor, 1, 0))

    expect(pressIn(editor, 'Enter', { ctrlKey: true })).toBe(true)
    expect(tasks.blocks.get(B)?.todo_state).toBe('TODO')
    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'one'],
      [B, 0, 'two'],
    ])
    await findIn(blockEl(container, B), MARKER)
    expect(blockEl(container, A).querySelector(MARKER)).toBeNull()
  })
})

describe('the metadata row', () => {
  function metadataTasks(): FakeTasks {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { priority: '1', due_date: '2026-10-20', scheduled_date: '2026-10-21' })
    tasks.setProperties(A, [
      { key: 'assignee', value: 'Ana' },
      { key: 'repeat', value: 'weekly' },
    ])
    return tasks
  }

  it('draws the badge, the date chips, the repeat rule and the property chips under the text, with no a11y violations', async () => {
    const { container } = mount(
      [
        [A, 0, 'pay rent'],
        [B, 0, 'plain'],
      ],
      metadataTasks(),
    )

    const block = blockEl(container, A)
    const badge = await findIn(block, BADGE)
    expect(badge.getAttribute('aria-label')).toBe(t('block.priorityCycle', { level: 'P1' }))
    expect((await findIn(block, '.due-date-chip')).getAttribute('aria-label')).toBe(
      t('block.dueDate', { date: formatCompactDate('2026-10-20') }),
    )
    expect(await findIn(block, '.scheduled-chip')).toBeInstanceOf(HTMLElement)
    expect(
      [...block.querySelectorAll('[data-testid="property-chip"]')].map((chip) => chip.textContent),
    ).toEqual([expect.stringContaining('Ana')])
    expect(block.querySelector('.repeat-indicator')).not.toBeNull()
    const row = block.lastElementChild as HTMLElement
    expect(row).toHaveClass('page-block-metadata')
    expect(row.contentEditable).toBe('false')
    expect(row).toHaveAttribute('data-priority')
    expect(row).toHaveAttribute('data-properties')
    expect(block.querySelector('.page-block-content')?.contains(badge)).toBe(false)
    expect(blockEl(container, B).querySelector(ROW)).toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('draws the row for each one of what it shows alone, and none for the app’s own properties', () => {
    const tasks = new FakeTasks()
    const D = blockId(4)
    const E = blockId(5)
    const F = blockId(6)
    const G = blockId(7)
    tasks.setBlock(A, { priority: '2' })
    tasks.setBlock(B, { due_date: '2026-10-20' })
    tasks.setBlock(C, { scheduled_date: '2026-10-21' })
    tasks.setProperties(D, [{ key: 'repeat', value: 'daily' }])
    tasks.setProperties(E, [{ key: 'assignee', value: 'Ana' }])
    tasks.setProperties(F, [{ key: 'listStyle', value: 'bullet' }])
    tasks.attachments.take({ [G]: [attachmentOf(G)] })
    // The attachment's preview reads its bytes.
    mockedInvoke.mockImplementation(readsAttachmentBytes)
    const { container } = mount(
      [A, B, C, D, E, F, G].map((id): Row => [id, 0, id]),
      tasks,
    )

    const drawn = (id: string) => blockEl(container, id).querySelector(ROW)
    for (const id of [A, B, C, D, E, G]) expect(drawn(id)).not.toBeNull()
    expect(drawn(F)).toBeNull()
    expect(drawn(A)).toHaveAttribute('data-priority')
    expect(drawn(A)).not.toHaveAttribute('data-properties')
    expect(drawn(D)).not.toHaveAttribute('data-properties')
    expect(drawn(E)).toHaveAttribute('data-properties')
    expect(drawn(E)).not.toHaveAttribute('data-priority')
  })

  it('the badge cycles the priority, the chips open the date picker, the +N pill the drawer', async () => {
    const tasks = metadataTasks()
    tasks.setProperties(
      A,
      ['a', 'b', 'c', 'd'].map((key) => ({ key, value: key })),
    )
    const { container } = mount([[A, 0, 'pay rent']], tasks)
    const block = blockEl(container, A)

    fireEvent.click(await findIn(block, BADGE))
    await settle()
    expect(block.querySelector(BADGE)?.getAttribute('aria-label')).toBe(
      t('block.priorityCycle', { level: 'P2' }),
    )
    fireEvent.click(await findIn(block, '.due-date-chip'))
    fireEvent.click(await findIn(block, '.scheduled-chip'))
    fireEvent.click(await findIn(block, '[data-testid="property-overflow"]'))

    expect(tasks.cyclePriority).toHaveBeenCalledWith(A)
    expect(tasks.openDatePicker.mock.calls).toEqual([
      [A, 'due'],
      [A, 'schedule'],
    ])
    expect(tasks.openPropertyDrawer).toHaveBeenCalledWith(A)
  })

  it('a ref property’s chip goes to its target', async () => {
    const tasks = new FakeTasks()
    useResolveStore.getState().set(B, 'Launch', false)
    tasks.setProperties(A, [{ key: 'project', value: B, kind: 'ref' }])
    const { container } = mount([[A, 0, 'pay rent']], tasks)
    await findIn(blockEl(container, A), '[data-testid="property-chip"]')

    fireEvent.click(
      within(blockEl(container, A)).getByRole('button', {
        name: t('property.openRefTarget', { title: 'Launch' }),
      }),
    )

    expect(tasks.navigate).toHaveBeenCalledWith(B)
  })

  it('a store that clears everything takes the row off', async () => {
    const tasks = metadataTasks()
    const { container } = mount([[A, 0, 'pay rent']], tasks)
    await findIn(blockEl(container, A), BADGE)

    act(() => {
      tasks.setBlock(A, { priority: null, due_date: null, scheduled_date: null })
      tasks.setProperties(A, [])
    })

    expect(blockEl(container, A).querySelector(ROW)).toBeNull()
  })

  it('redraws a control only for a change to what it shows', async () => {
    const tasks = metadataTasks()
    tasks.setBlock(A, { todo_state: 'TODO' })
    const { container } = mount([[A, 0, 'pay rent']], tasks)
    await findIn(blockEl(container, A), BADGE)
    // The attachment's preview reads its bytes.
    mockedInvoke.mockImplementation(readsAttachmentBytes)
    const update = vi.spyOn(ReactRenderer.prototype, 'updateProps')

    act(() => tasks.changed())
    act(() => tasks.setBlock(A, { content: 'elsewhere' }))
    expect(update).not.toHaveBeenCalled()

    const changes: Array<() => void> = [
      () => tasks.setBlock(A, { priority: '3' }),
      () => tasks.setBlock(A, { due_date: '2026-12-01' }),
      () => tasks.setBlock(A, { scheduled_date: '2026-12-02' }),
      () => tasks.setProperties(A, [{ key: 'assignee', value: 'Bo' }]),
      () => tasks.attachments.take({ [A]: [attachmentOf(A)] }),
      () => tasks.setBlock(A, { todo_state: 'DOING' }),
    ]
    for (const change of changes) {
      update.mockClear()
      act(change)
      expect(update).toHaveBeenCalledTimes(1)
    }
    update.mockRestore()
  })
})

describe('the controls mount as the block nears the viewport', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  function observer(): MockIntersectionObserver {
    expect(MockIntersectionObserver.instances).toHaveLength(1)
    return MockIntersectionObserver.instances[0] as MockIntersectionObserver
  }

  function report(el: Element, isIntersecting: boolean): void {
    act(() => observer().trigger([{ target: el, isIntersecting }]))
  }

  function offscreenTasks(): FakeTasks {
    const tasks = new FakeTasks()
    tasks.setBlock(B, { todo_state: 'TODO', priority: '1' })
    tasks.setProperties(B, [{ key: 'assignee', value: 'Ana' }])
    return tasks
  }

  it('shows each control’s box, the checkbox’s naming its state, and the controls once near', async () => {
    const { container } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
      ],
      offscreenTasks(),
    )
    const block = blockEl(container, B)
    const box = block.querySelector('.page-block-controls') as HTMLElement

    expect(observer().observed.has(block)).toBe(true)
    expect(observer().rootMargin).toBe('100% 0px')
    expect(box).toHaveAttribute('role', 'img')
    expect(box).toHaveAttribute('aria-label', t('block.todoCycleTip', { state: 'TODO' }))
    expect(box.childElementCount).toBe(0)
    expect(block.querySelector(ROW)?.childElementCount).toBe(0)
    expect(block.querySelector(ROW)).toHaveAttribute('data-priority')
    expect(await axe(container)).toHaveNoViolations()

    report(block, false)
    expect(box.childElementCount).toBe(0)

    report(block, true)
    expect(await findIn(block, MARKER)).toBeInstanceOf(HTMLElement)
    expect(await findIn(block, BADGE)).toBeInstanceOf(HTMLElement)
    expect(box).not.toHaveAttribute('role')
    expect(box).not.toHaveAttribute('aria-label')
    expect(observer().observed.has(block)).toBe(false)
  })

  it('a control the block gains once mounted mounts at once; one gained before waits', async () => {
    const tasks = new FakeTasks()
    const { container } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'second'],
      ],
      tasks,
    )
    report(blockEl(container, A), true)

    act(() => {
      tasks.setBlock(A, { todo_state: 'TODO', priority: '1' })
      tasks.setBlock(B, { todo_state: 'TODO' })
    })

    expect(await findIn(blockEl(container, A), MARKER)).toBeInstanceOf(HTMLElement)
    expect(await findIn(blockEl(container, A), BADGE)).toBeInstanceOf(HTMLElement)
    const mounted = blockEl(container, A).querySelector('.page-block-controls') as HTMLElement
    act(() => tasks.setBlock(A, { todo_state: 'DOING' }))
    expect(mounted).not.toHaveAttribute('role')
    expect(mounted).not.toHaveAttribute('aria-label')
    const waiting = blockEl(container, B).querySelector('.page-block-controls') as HTMLElement
    expect(waiting.childElementCount).toBe(0)
    expect(waiting).toHaveAttribute('aria-label', t('block.todoCycleTip', { state: 'TODO' }))

    act(() => tasks.setBlock(B, { todo_state: 'DONE' }))
    expect(waiting).toHaveAttribute('aria-label', t('block.todoCycleTip', { state: 'DONE' }))
  })

  it('watches the blocks from the scroller the page is in, one observer for every block', async () => {
    const { container, editor, getByTestId } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
      ],
      offscreenTasks(),
    )
    expect(observer().root).toBe(getByTestId('scroller'))

    // As a reload brings a new block in, the caret staying in the first block.
    act(() => {
      const third = editor.schema.nodeFromJSON({
        type: 'pageBlock',
        attrs: { blockId: C, depth: 0 },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }],
      })
      editor.view.dispatch(
        editor.state.tr.insert(editor.state.doc.content.size, third).setMeta(REMOTE_PATCH, true),
      )
    })

    expect(observer().observed.has(blockEl(container, C))).toBe(true)
    expect(observer().observed.has(blockEl(container, B))).toBe(true)
  })

  it('a block drawn anew mounts its controls at once if its id mounted them before, else waits', async () => {
    const tasks = offscreenTasks()
    tasks.setBlock(C, { todo_state: 'DONE' })
    const { container, editor } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
        [C, 0, 'later'],
      ],
      tasks,
    )
    report(blockEl(container, B), true)
    await findIn(blockEl(container, B), MARKER)

    // As a reload brings a new depth in, the caret staying in the first block.
    act(() => {
      const { doc } = editor.state
      const second = doc.child(0).nodeSize
      const third = second + doc.child(1).nodeSize
      editor.view.dispatch(
        editor.state.tr
          .setNodeAttribute(second, 'depth', 1)
          .setNodeAttribute(third, 'depth', 1)
          .setMeta(REMOTE_PATCH, true),
      )
    })

    expect(blockEl(container, B)).toHaveAttribute('data-depth', '1')
    expect(await findIn(blockEl(container, B), MARKER)).toBeInstanceOf(HTMLElement)
    const later = blockEl(container, C)
    expect(later).toHaveAttribute('data-depth', '1')
    expect(later.querySelector(MARKER)).toBeNull()
    expect(observer().observed.has(later)).toBe(true)
  })

  it('a block whose child the caret selects mounts its controls', async () => {
    const { container, editor } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task\n\n---'],
      ],
      offscreenTasks(),
    )

    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, ruleIn(editor, 1))),
      )
    })

    expect(await findIn(blockEl(container, B), MARKER)).toBeInstanceOf(HTMLElement)
  })

  it('the caret entering a block mounts its controls', async () => {
    const { container, editor } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
      ],
      offscreenTasks(),
    )

    act(() => caret(editor, 1, 2))

    expect(await findIn(blockEl(container, B), MARKER)).toBeInstanceOf(HTMLElement)
  })

  it('a mounted block drawn anew, at a new depth, mounts its controls at once', async () => {
    const tasks = offscreenTasks()
    const { container, editor } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
      ],
      tasks,
    )
    report(blockEl(container, B), true)
    await findIn(blockEl(container, B), MARKER)

    act(() => caret(editor, 1, 0))
    expect(pressIn(editor, 'Tab')).toBe(true)

    expect(rowsOf(editor.state.doc)).toEqual([
      [A, 0, 'first'],
      [B, 1, 'task'],
    ])
    const drawn = blockEl(container, B)
    expect(drawn).toHaveAttribute('data-depth', '1')
    expect(await findIn(drawn, MARKER)).toBeInstanceOf(HTMLElement)
    expect(observer().observed.has(drawn)).toBe(false)
  })

  it('a block deleted before it nears the view is no longer observed, nor listens', () => {
    const tasks = offscreenTasks()
    const { container, editor } = mount(
      [
        [A, 0, 'first'],
        [B, 0, 'task'],
      ],
      tasks,
    )
    const block = blockEl(container, B)
    expect(tasks.listenerCount()).toBe(2)

    act(() => {
      editor.commands.deleteRange({
        from: editor.state.doc.child(0).nodeSize,
        to: editor.state.doc.content.size,
      })
    })

    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, 'first']])
    expect(observer().observed.has(block)).toBe(false)
    expect(tasks.listenerCount()).toBe(1)
  })
})

describe('the view follows its block', () => {
  it('a block whose id changes draws that id’s controls', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'TODO' })
    tasks.setBlock(B, { priority: '2' })
    const { container, editor } = mount([[A, 0, 'one']], tasks)
    await findIn(blockEl(container, A), MARKER)

    act(() => {
      // As a reload brings it in: the id rules leave the backend's ids be.
      editor.view.dispatch(
        editor.state.tr.setNodeAttribute(0, 'blockId', B).setMeta(REMOTE_PATCH, true),
      )
    })

    const block = blockEl(container, B)
    expect(block.querySelector(MARKER)).toBeNull()
    expect(await findIn(block, BADGE)).toBeInstanceOf(HTMLElement)
  })

  it('typing in a block keeps its view and its controls', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'TODO' })
    const { container, editor } = mount([[A, 0, 'one']], tasks)
    const block = blockEl(container, A)
    const checkbox = await findIn(block, MARKER)

    act(() => {
      editor
        .chain()
        .setTextSelection(posIn(editor, 0, 3))
        .insertContent('!')
        .run()
    })

    expect(rowsOf(editor.state.doc)).toEqual([[A, 0, 'one!']])
    expect(blockEl(container, A)).toBe(block)
    expect(block.querySelector(MARKER)).toBe(checkbox)
  })

  it('a selection made in a control’s text is read as the editor’s', async () => {
    const tasks = new FakeTasks()
    tasks.setProperties(B, [{ key: 'assignee', value: 'Ana' }])
    const { container, editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    const chip = await findIn(blockEl(container, B), '[data-testid="property-chip"]')
    act(() => {
      editor.view.focus()
      caret(editor, 0, 1)
    })
    const text = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT).nextNode() as Text

    act(() => {
      document.getSelection()?.collapse(text, 1)
      ;(editor.view as unknown as { domObserver: { flush: () => void } }).domObserver.flush()
    })

    expect(editor.state.selection.$head.index(0)).toBe(1)
  })

  it('a key in a control is the control’s, and one in the text the editor’s', async () => {
    const tasks = new FakeTasks()
    tasks.setBlock(A, { todo_state: 'TODO', priority: '1' })
    const { container } = mount([[A, 0, 'one']], tasks)
    const block = blockEl(container, A)

    fireEvent.keyDown(await findIn(block, MARKER), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(await findIn(block, BADGE), { key: 'Enter', ctrlKey: true })
    expect(tasks.cycle).not.toHaveBeenCalled()

    fireEvent.keyDown(block.querySelector('.page-block-content p') as HTMLElement, {
      key: 'Enter',
      ctrlKey: true,
    })
    expect(tasks.cycle).toHaveBeenCalledTimes(1)
  })
})

describe('the list marker', () => {
  function mountList(rows: readonly Row[], styles: Record<string, PropertyRow[]>) {
    const lists = new PageLists(
      styles,
      rows.map(([id, depth]) => ({ id, depth })),
    )
    const mounted = mountNodeViews(rows, undefined, lists)
    teardown = () => {
      mounted.unmount()
      mounted.editor.destroy()
    }
    return mounted
  }

  const markerIn = (container: HTMLElement, id: string) =>
    blockEl(container, id).querySelector(':scope > [data-testid="list-marker"]')

  it('leads a list block’s first line, outside the text and hidden from assistive technology', () => {
    const { container } = mountList(
      [
        [A, 0, 'dot'],
        [B, 0, 'plain'],
      ],
      { [A]: listStyle('bullet') },
    )

    const marker = markerIn(container, A) as HTMLElement
    expect(marker.textContent).toBe('•')
    expect(marker).toHaveClass('list-marker')
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker.contentEditable).toBe('false')
    expect(marker.nextElementSibling).toHaveClass('page-block-content')
    expect(markerIn(container, B)).toBeNull()
  })

  it('follows a style given, changed or taken off, in place', () => {
    const { container, lists } = mountList(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      { [A]: listStyle('bullet') },
    )
    const marker = markerIn(container, A)

    act(() => {
      lists.want(A, 'ordered')
      lists.want(B, 'ordered')
    })
    expect([markerIn(container, A)?.textContent, markerIn(container, B)?.textContent]).toEqual([
      '1.',
      '2.',
    ])
    expect(markerIn(container, A)).toBe(marker)

    act(() => {
      lists.want(A, 'none')
    })
    expect(markerIn(container, A)).toBeNull()
    expect(markerIn(container, B)?.textContent).toBe('1.')
  })

  it('a block’s view deleted stops listening to its marker', () => {
    const lists = new PageLists({ [B]: listStyle('bullet') }, [
      { id: A, depth: 0 },
      { id: B, depth: 0 },
    ])
    const stopped: string[] = []
    const subscribe = lists.subscribe.bind(lists)
    vi.spyOn(lists, 'subscribe').mockImplementation((id, listener) => {
      const off = subscribe(id, listener)
      return () => {
        stopped.push(id)
        off()
      }
    })
    const { editor, unmount } = mountNodeViews(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      undefined,
      lists,
    )
    teardown = () => {
      unmount()
      editor.destroy()
    }
    // The views drawn before the editor was in the page are gone.
    stopped.length = 0

    act(() => {
      editor.commands.deleteRange({
        from: editor.state.doc.child(0).nodeSize,
        to: editor.state.doc.content.size,
      })
    })

    expect(stopped).toEqual([B])
  })
})

describe('a query or an embed', () => {
  const QUERY = '{{query tag:work}}'
  const rendered = (container: HTMLElement, id: string) =>
    blockEl(container, id).querySelector(':scope > .page-block-rendered')

  beforeEach(() => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  /** Replace block `index`'s text with `text`, as a reload brings it in. */
  function reload(editor: Editor, index: number, text: string): void {
    act(() => {
      const from = posIn(editor, index, 0)
      const to = from + editor.state.doc.child(index).child(0).content.size
      editor.view.dispatch(editor.state.tr.insertText(text, from, to).setMeta(REMOTE_PATCH, true))
    })
  }

  it('draws its results after the text, a plain block none', async () => {
    const { container } = mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
    ])
    await settle()

    const drawn = rendered(container, B) as HTMLElement
    expect(drawn.previousElementSibling).toHaveClass('page-block-content')
    expect(drawn.contentEditable).toBe('false')
    expect(blockEl(container, B)).toHaveAttribute(RENDERED, '')
    expect(drawn).toHaveTextContent('tag: work')
    expect(rendered(container, A)).toBeNull()
    expect(blockEl(container, A)).not.toHaveAttribute(RENDERED)
  })

  it('a reload that makes a block a query draws its results; one that makes it plain takes them off', async () => {
    const { container, editor } = mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
    ])

    reload(editor, 0, '{{query tag:personal}}')
    reload(editor, 1, 'plain now')
    reload(editor, 0, QUERY)
    await settle()

    expect(rendered(container, A)).toHaveTextContent('tag: work')
    expect(blockEl(container, A).querySelectorAll('.page-block-rendered')).toHaveLength(1)
    expect(blockEl(container, A)).toHaveAttribute(RENDERED, '')
    expect(rendered(container, B)).toBeNull()
    expect(blockEl(container, B)).not.toHaveAttribute(RENDERED)
  })

  it('its results mount once the block nears the view, as the other controls do', async () => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    const { container } = mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
    ])
    await settle()
    const box = rendered(container, B) as HTMLElement
    expect(box.childElementCount).toBe(0)

    act(() => {
      ;(MockIntersectionObserver.instances[0] as MockIntersectionObserver).trigger([
        { target: blockEl(container, B), isIntersecting: true },
      ])
    })
    await settle()

    expect(box).toHaveTextContent('tag: work')
  })

  it('while the caret is in the block its results keep the text it came with', async () => {
    const { container, editor } = mount([
      [A, 0, 'first'],
      [B, 0, QUERY],
    ])
    act(() => {
      editor.view.focus()
      caret(editor, 1, 0)
    })

    reload(editor, 1, '{{query tag:personal}}')
    await settle()
    expect(rendered(container, B)).toHaveTextContent('tag: work')

    act(() => caret(editor, 0, 0))
    await settle()
    expect(rendered(container, B)).toHaveTextContent('tag: personal')
  })
})

describe('the task keys', () => {
  it('Ctrl+Shift+1–3 set the caret’s block’s priority, and its badge shows it', async () => {
    const tasks = new FakeTasks()
    const { container, editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    act(() => caret(editor, 1, 1))

    for (const level of ['1', '2', '3'] as const) {
      expect(pressIn(editor, level, { ctrlKey: true, shiftKey: true })).toBe(true)
      expect(tasks.blocks.get(B)?.priority).toBe(level)
    }
    expect((await findIn(blockEl(container, B), BADGE)).getAttribute('aria-label')).toBe(
      t('block.priorityCycle', { level: 'P3' }),
    )
    expect(tasks.blocks.get(A)).toBeUndefined()
  })

  it('Ctrl+Shift+D opens the date picker to link a date, Ctrl+Shift+P the caret’s block’s drawer', () => {
    const tasks = new FakeTasks()
    const { editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    act(() => caret(editor, 1, 0))

    expect(pressIn(editor, 'D', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(pressIn(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(pressIn(editor, 'x')).toBe(false)

    expect(tasks.openDateLinkPicker).toHaveBeenCalledTimes(1)
    expect(tasks.openPropertyDrawer.mock.calls).toEqual([[B]])
    expect(tasks.cycle).not.toHaveBeenCalled()
  })

  it('act on the block whose child the caret selects', () => {
    const tasks = new FakeTasks()
    const { editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two\n\n---'],
      ],
      tasks,
    )
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, ruleIn(editor, 1))),
      )
    })

    expect(pressIn(editor, 'Enter', { ctrlKey: true })).toBe(true)
    expect(pressIn(editor, '2', { ctrlKey: true, shiftKey: true })).toBe(true)

    expect(tasks.blocks.get(B)).toMatchObject({ todo_state: 'TODO', priority: '2' })
  })

  it('with the whole page selected, no key acts on a block: each is left to the editor', () => {
    const tasks = new FakeTasks()
    const { editor } = mount([[A, 0, 'one']], tasks)
    const selectAll = () =>
      act(() => {
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
      })

    selectAll()
    expect(pressIn(editor, 'P', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(pressIn(editor, '1', { ctrlKey: true, shiftKey: true })).toBe(false)
    // The editor's own Ctrl+Enter, a hard break in place of the page's text.
    expect(pressIn(editor, 'Enter', { ctrlKey: true })).toBe(true)
    expect(rowsOf(editor.state.doc).map(([, , markdown]) => markdown)).toEqual(['\\\n'])
    expect(tasks.cycle).not.toHaveBeenCalled()
    expect(tasks.openPropertyDrawer).not.toHaveBeenCalled()
    expect(tasks.setPriority).not.toHaveBeenCalled()
  })
})

describe('files pasted or dropped', () => {
  const file = () => new File(['hi'], 'notes.txt', { type: 'text/plain' })

  function paste(editor: Editor, files: File[]): boolean {
    let taken = false
    act(() => {
      const clipboardData = { files, types: [], getData: () => '' }
      const event = { clipboardData, preventDefault: () => {} } as unknown as ClipboardEvent
      taken =
        editor.view.someProp('handlePaste', (f) =>
          f(editor.view, event, editor.state.doc.slice(0, 0)),
        ) ?? false
    })
    return taken
  }

  /** A paste event with no clipboard data, as a synthetic one may come. */
  function pasteWithout(editor: Editor): boolean {
    let taken = false
    act(() => {
      const event = { clipboardData: null, preventDefault: () => {} } as unknown as ClipboardEvent
      taken =
        editor.view.someProp('handlePaste', (f) =>
          f(editor.view, event, editor.state.doc.slice(0, 0)),
        ) ?? false
    })
    return taken
  }

  function dropWithout(editor: Editor): boolean {
    let taken = false
    act(() => {
      const event = { dataTransfer: null, clientX: 1, clientY: 1 } as unknown as DragEvent
      taken =
        editor.view.someProp('handleDrop', (f) =>
          f(editor.view, event, editor.state.doc.slice(0, 0), false),
        ) ?? false
    })
    return taken
  }

  function drop(editor: Editor, files: File[], pos: number): boolean {
    const at = vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
    let taken = false
    act(() => {
      const event = { dataTransfer: { files }, clientX: 1, clientY: 1 } as unknown as DragEvent
      taken =
        editor.view.someProp('handleDrop', (f) =>
          f(editor.view, event, editor.state.doc.slice(0, 0), false),
        ) ?? false
    })
    at.mockRestore()
    return taken
  }

  it('a file pasted goes to the caret’s block; a paste with none is text', () => {
    const tasks = new FakeTasks()
    const { editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    act(() => caret(editor, 1, 1))
    const pasted = file()

    expect(paste(editor, [pasted])).toBe(true)
    expect(paste(editor, [])).toBe(false)
    expect(pasteWithout(editor)).toBe(false)

    expect(tasks.attach.mock.calls).toEqual([[B, [pasted]]])
  })

  it('a file pasted over the whole page goes to its first block', () => {
    const tasks = new FakeTasks()
    const { editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    })
    const pasted = file()

    expect(paste(editor, [pasted])).toBe(true)

    expect(tasks.attach.mock.calls).toEqual([[A, [pasted]]])
  })

  it('a file dropped goes to the block it lands on; a drop with none is the editor’s', () => {
    const tasks = new FakeTasks()
    const { editor } = mount(
      [
        [A, 0, 'one'],
        [B, 0, 'two'],
      ],
      tasks,
    )
    const second = editor.state.doc.child(0).nodeSize
    const dropped = file()

    expect(drop(editor, [dropped], second + 3)).toBe(true)
    expect(drop(editor, [dropped], second + 1)).toBe(true)
    expect(drop(editor, [dropped], second)).toBe(true)
    expect(drop(editor, [], second + 3)).toBe(false)
    expect(dropWithout(editor)).toBe(false)

    expect(tasks.attach.mock.calls).toEqual([
      [B, [dropped]],
      [B, [dropped]],
      [B, [dropped]],
    ])
  })
})

describe('leadingTask', () => {
  function first(markdown: string) {
    const editor = openPage([[A, 0, markdown]])
    teardown = () => editor.destroy()
    return leadingTask(editor.state.doc.child(0))
  }

  it('reads a typed marker’s state and length, bare or after `- `', () => {
    expect(first('\\[ \\] buy milk')).toEqual({ todoState: 'TODO', length: 4 })
    expect(first('\\- \\[x\\] buy milk')).toEqual({ todoState: 'DONE', length: 6 })
    expect(first('\\[/\\] buy milk')).toEqual({ todoState: 'DOING', length: 4 })
  })

  it('counts an inline node one character, and finds none in plain text, `TODO` or a code block', () => {
    expect(first(`\\[ \\] [[${B}]] x`)).toEqual({ todoState: 'TODO', length: 4 })
    expect(first(`\\[ \\][[${B}]] x`)).toBeNull()
    expect(first('TODO buy milk')).toBeNull()
    expect(first('buy milk')).toBeNull()
    expect(first('```\n[ ] buy milk\n```')).toBeNull()
  })
})

describe('commitPageTask', () => {
  beforeEach(() => {
    seedBlocks()
    useSpaceStore.setState({ currentSpaceId: SCOPE.space_id })
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
  })

  const backendState = (id: string) =>
    (dispatch('get_block', { blockId: id }) as BlockRow).todo_state

  /** Block `id` of a seeded page, saved as `markdown`; `loaded`, what it held before, if not new. */
  function saved(markdown: string, loaded: string | null = null) {
    const { pageId, ids } = seedPage(['x'])
    const id = ids[0] as string
    const rows: Row[] = [[id, 0, markdown]]
    const backend = new FakeBackend(rows, pageId)
    const editor = openPage(rows)
    const before = loaded === null ? null : openPage([[id, 0, loaded]])
    teardown = () => {
      editor.destroy()
      before?.destroy()
    }
    const save = createSaveState(pageId, treeRows(rows, pageId), editor.state.doc)
    return {
      id,
      backend,
      save,
      loaded: before?.state.doc.child(0) ?? null,
      store: createPageBlockStore(pageId),
    }
  }

  it('makes a marker typed into a new block its state, then writes the text without it', async () => {
    const { id, backend, save, loaded, store } = saved('\\[ \\] buy milk')

    const result = await commitPageTask(id, loaded, save, backend, store)

    expect(backendState(id)).toBe('TODO')
    expect(backend.live()).toEqual([[id, 0, 'buy milk']])
    expect(result).toEqual({ refs: [{ device_id: 'fake', seq: 1 }], markdown: 'buy milk' })
    expect(save.writes).toBe(1)
  })

  it('a marker typed into a block that held none before becomes its state', async () => {
    const { id, backend, save, loaded, store } = saved('\\[ \\] buy milk', 'buy milk')

    const result = await commitPageTask(id, loaded, save, backend, store)

    expect(backendState(id)).toBe('TODO')
    expect(result.markdown).toBe('buy milk')
  })

  it('a marker the block held before it was edited stays text', async () => {
    const { id, backend, save, loaded, store } = saved('\\[ \\] buy milk!', '\\[ \\] buy milk')

    const result = await commitPageTask(id, loaded, save, backend, store)

    expect(result).toEqual({ refs: [], markdown: '\\[ \\] buy milk!' })
    expect(backendState(id)).toBeNull()
    expect(backend.calls).toEqual([])
  })

  it('a block with no marker, or none saved, writes nothing', async () => {
    const { id, backend, save, store } = saved('buy milk', 'buy')

    expect(await commitPageTask(id, null, save, backend, store)).toEqual({
      refs: [],
      markdown: 'buy milk',
    })
    expect(await commitPageTask(C, null, save, backend, store)).toEqual({
      refs: [],
      markdown: undefined,
    })
    expect(backendState(id)).toBeNull()
    expect(backend.calls).toEqual([])
  })

  it('a refused state write says so, and the marker stays text', async () => {
    const { id, backend, save, loaded, store } = saved('\\[ \\] buy milk')
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'set_todo_state') throw new Error('database locked')
      return dispatch(cmd, args)
    })
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await commitPageTask(id, loaded, save, backend, store)

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('blockTree.setTaskStateFailed'))
    expect(result).toEqual({ refs: [], markdown: '\\[ \\] buy milk' })
    expect(backendState(id)).toBeNull()
    expect(backend.live()).toEqual([[id, 0, '\\[ \\] buy milk']])
    expect(save.writes).toBe(0)
  })

  it('a refused text write keeps the state, and the text as saved', async () => {
    const { id, backend, save, loaded, store } = saved('\\[ \\] buy milk')
    backend.failing = (kind) => kind === 'edit'
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const result = await commitPageTask(id, loaded, save, backend, store)

    expect(backendState(id)).toBe('TODO')
    expect(backend.live()).toEqual([[id, 0, '\\[ \\] buy milk']])
    expect(result).toEqual({ refs: [], markdown: '\\[ \\] buy milk' })
    expect(save.writes).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
