/**
 * Page mode's continuous save (#5691): what reaches the block commands, in
 * what order, and what the backend holds after it (`FakeBackend`, which
 * refuses what the real commands refuse).
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeContentDelta } from '@/editor/content-delta'
import {
  blockId,
  caret,
  FakeBackend,
  openPage,
  PAGE,
  posIn,
  press,
  type Row,
  treeRows,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { createSaveState, type PageSaveState, savePage } from '@/editor/page-mode/page-save'

vi.mock('@/editor/content-delta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/content-delta')>()
  return { ...actual, computeContentDelta: vi.fn(actual.computeContentDelta) }
})

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const NEW_1 = '01NEW000000000000000000001'
const NEW_2 = '01NEW000000000000000000002'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

interface Page {
  ed: Editor
  backend: FakeBackend
  state: PageSaveState
  save: () => Promise<unknown>
}

function open(rows: Row[]): Page {
  const ed = openPage(rows)
  editor = ed
  const backend = new FakeBackend(rows)
  const state = createSaveState(PAGE, treeRows(rows), ed.state.doc)
  const save = async () => (await savePage(ed.state.doc, state, backend)).error
  return { ed, backend, state, save }
}

/** Cut the selection `from`–`to` through the view, as Ctrl+X does; resolves the clipboard's HTML. */
function cut(ed: Editor, from: number, to: number): string {
  ed.commands.setTextSelection({ from, to })
  const data = new DataTransfer()
  ed.view.dom.dispatchEvent(
    new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
  )
  return data.getData('text/html')
}

describe('what a save writes', () => {
  it('writes nothing on open, nor for a block that changed only how the serialiser would write it (#711)', async () => {
    const { ed, backend, state, save } = open([
      [A, 0, '_em_ and 3. item'],
      [B, 0, 'plain'],
    ])
    await save()
    caret(ed, 1, 0)
    press(ed, 'Tab')
    press(ed, 'Tab', { shiftKey: true })
    caret(ed, 0, 0)
    press(ed, 'Tab')

    await save()

    expect(backend.calls).toEqual([])
    expect(state.writes).toBe(0)
    expect(backend.live()).toEqual([
      [A, 0, '_em_ and 3. item'],
      [B, 0, 'plain'],
    ])
  })

  it('compares only the block typed in, and writes only it', async () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => [blockId(i + 1), 0, `block ${i}`])
    const { ed, backend, save } = open(rows)
    caret(ed, 20, 0)
    type(ed, 'x')
    vi.mocked(computeContentDelta).mockClear()

    await save()

    expect(vi.mocked(computeContentDelta)).toHaveBeenCalledTimes(1)
    expect(backend.calls).toEqual([`edit ${blockId(21)}`])
    expect(backend.live()[20]).toEqual([blockId(21), 0, 'xblock 20'])
  })

  it('keeps a block whose write failed unsaved, so the next save writes it', async () => {
    const { ed, backend, save } = open([[A, 0, 'foo']])
    caret(ed, 0, 3)
    type(ed, '!')
    backend.failing = (kind) => kind === 'edit'

    expect(await save()).toBeInstanceOf(Error)
    expect(backend.live()).toEqual([[A, 0, 'foo']])

    backend.reset()
    await save()

    expect(backend.calls).toEqual([`edit ${A}`])
    expect(backend.live()).toEqual([[A, 0, 'foo!']])
  })

  it('counts its writes, and says whether one changed the page’s shape', async () => {
    const { ed, backend, state } = open([[A, 0, 'foo']])
    caret(ed, 0, 3)
    type(ed, '!')
    const edit = await savePage(ed.state.doc, state, backend)
    expect([state.writes, edit.structural]).toEqual([1, false])

    press(ed, 'Enter')
    type(ed, 'new')
    const create = await savePage(ed.state.doc, state, backend)

    expect([state.writes, create.structural]).toEqual([2, true])
  })

  it('deletes a block cut with its child once: the child goes with it', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    cut(ed, posIn(ed, 0, 0), posIn(ed, 2, 0))

    await save()

    expect(backend.calls).toEqual([`delete ${A}`])
    expect(backend.live()).toEqual([[C, 0, 'c']])
  })

  it('creates a new block only once it holds something', async () => {
    const { ed, backend, save } = open([[A, 0, 'foo']])
    caret(ed, 0, 3)
    press(ed, 'Enter')

    await save()
    expect(backend.calls).toEqual([])

    type(ed, 'bar')
    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, 'bar'],
    ])
  })

  it('creates an empty block that holds a block, before moving that block under it', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 0, 3)
    press(ed, 'Enter')
    caret(ed, 2, 0)
    press(ed, 'Tab')

    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`, `move ${B}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, ''],
      [B, 1, 'bar'],
    ])
  })

  it('creates a block under a parent created in the same save', async () => {
    const { ed, backend, save } = open([[A, 0, 'foo']])
    caret(ed, 0, 3)
    press(ed, 'Enter')
    type(ed, 'parent')
    press(ed, 'Enter')
    type(ed, 'child')
    press(ed, 'Tab')

    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`, `create ${NEW_2}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, 'parent'],
      [NEW_2, 1, 'child'],
    ])
  })
})

describe('the order of a save', () => {
  it('creates the half split off before it shortens the block it came from (#5272)', async () => {
    const { ed, backend, save } = open([[A, 0, 'foo bar']])
    caret(ed, 0, 3)
    press(ed, 'Enter')

    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`, `edit ${A}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [NEW_1, 0, ' bar'],
    ])
  })

  it('stops at a failed create, leaving the split block whole', async () => {
    const { ed, backend, save } = open([[A, 0, 'foo bar']])
    caret(ed, 0, 3)
    press(ed, 'Enter')
    backend.failing = (kind) => kind === 'create'

    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`])
    expect(backend.live()).toEqual([[A, 0, 'foo bar']])
  })

  it('moves the children of a joined block out before it deletes the block', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')

    await save()

    expect(backend.calls).toEqual([`move ${C}`, `edit ${A}`, `delete ${B}`])
    expect(backend.live()).toEqual([
      [A, 0, 'ab'],
      [C, 1, 'c'],
    ])
  })

  it('keeps the deletes back when a move fails, so no block is deleted under its child', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    backend.failing = (kind) => kind === 'move'

    await save()

    expect(backend.calls).toEqual([`move ${C}`, `edit ${A}`])
    expect(backend.live()).toEqual([
      [A, 0, 'ab'],
      [B, 0, 'b'],
      [C, 1, 'c'],
    ])
  })
})

describe('when the backend refuses', () => {
  it('holds the deletes back while an edit fails, so a joined block’s text is never lost', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    backend.failing = (kind) => kind === 'edit'

    expect(await save()).toBeInstanceOf(Error)

    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
  })

  it('stops with an error when a restore does not bring the block back, and tries it once', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    await save()
    backend.reset()
    backend.restore = (id) => {
      backend.calls.push(`restore ${id}`)
      return Promise.resolve()
    }
    ed.commands.undo()

    const error = await save()

    expect(String(error)).toContain(`restoring block ${B} did not bring it back`)
    expect(backend.calls).toEqual([`restore ${B}`, 'tree'])
  })
})

describe('structure', () => {
  it('Tab moves a block under the one before it, and Shift+Tab moves it back after it', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Tab')
    await save()
    expect(backend.live()).toEqual([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])

    backend.reset()
    press(ed, 'Tab', { shiftKey: true })
    await save()

    expect(backend.calls).toEqual([`move ${B}`])
    expect(backend.live()).toEqual([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
  })

  it('places a block created after a delete among the siblings left', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    // Deleting from A's start to B's start leaves B, so the deleted block comes first.
    ed.commands.setTextSelection({ from: posIn(ed, 0, 0), to: posIn(ed, 1, 0) })
    press(ed, 'Backspace')
    await save()
    expect(backend.live()).toEqual([
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])

    caret(ed, 0, 1)
    press(ed, 'Enter')
    type(ed, 'new')
    await save()

    expect(backend.live()).toEqual([
      [B, 0, 'b'],
      [NEW_1, 0, 'new'],
      [C, 0, 'c'],
    ])
  })

  it('after each save, holds the backend’s tree, so the next save writes nothing', async () => {
    const D = blockId(4)
    const { ed, backend, state, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [D, 0, 'd'],
    ])
    const mirror = (): Array<[string, number]> => {
      const rows: Array<[string, number]> = []
      const walk = (parentId: string, depth: number): void => {
        for (const id of state.tree.children.get(parentId) ?? []) {
          rows.push([id, depth])
          walk(id, depth + 1)
        }
      }
      walk(PAGE, 0)
      return rows
    }
    const backendTree = () => backend.live().map(([id, depth]) => [id, depth])
    const savedAndHeld = async () => {
      await save()
      expect(mirror()).toEqual(backendTree())
      backend.calls.length = 0
      await save()
      expect(backend.calls).toEqual([])
    }

    caret(ed, 0, 1)
    press(ed, 'Enter')
    type(ed, 'new')
    await savedAndHeld()

    // A cut and pasted after C moves it forward among its siblings.
    const html = cut(ed, posIn(ed, 0, 0), posIn(ed, 1, 0))
    caret(ed, 3, 0)
    ed.view.pasteHTML(html)
    await savedAndHeld()

    expect(backend.live()).toEqual([
      [NEW_1, 0, 'new'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [A, 0, 'a'],
      [D, 0, 'd'],
    ])
  })

  it('creates the blocks a paste of paragraphs brings, in their order', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    caret(ed, 0, 1)
    ed.view.pasteHTML('<p>x</p><p>y</p><p>z</p>')

    await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`, `create ${NEW_2}`, `edit ${A}`])
    expect(backend.live()).toEqual([
      [A, 0, 'ax'],
      [NEW_1, 0, 'y'],
      [NEW_2, 0, 'z'],
      [B, 0, 'b'],
    ])
  })

  it('moves two blocks cut and pasted together, in their order', async () => {
    const D = blockId(4)
    const E = blockId(5)
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
      [D, 0, 'd'],
      [E, 0, 'e'],
    ])
    const html = cut(ed, posIn(ed, 0, 0), posIn(ed, 2, 0))
    caret(ed, 2, 0)
    ed.view.pasteHTML(html)

    await save()

    expect(backend.live()).toEqual([
      [C, 0, 'c'],
      [D, 0, 'd'],
      [A, 0, 'a'],
      [B, 0, 'b'],
      [E, 0, 'e'],
    ])
  })

  it('brings back a block an undo restores by its id, never by creating it again', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
      [C, 1, 'child'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    await save()
    expect(backend.live()).toEqual([[A, 0, 'foobarchild']])

    backend.reset()
    ed.commands.undo()
    await save()
    // The restore of C brought back B, its deleted parent, which the page no longer shows.
    expect(backend.calls).toEqual([`restore ${C}`, 'tree', `move ${C}`, `edit ${A}`, `delete ${B}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foobar'],
      [C, 1, 'child'],
    ])

    backend.reset()
    ed.commands.undo()
    await save()

    expect(backend.calls).toEqual([`restore ${B}`, 'tree', `move ${C}`, `edit ${A}`])
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
      [C, 1, 'child'],
    ])
  })
})
