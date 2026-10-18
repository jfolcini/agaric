/**
 * Page mode after a change made elsewhere (#5691): a block changed elsewhere
 * is patched in when page mode holds no unsaved edit of it, outside undo
 * history and with the cursor mapped, and one with an unsaved edit keeps the
 * local text; blocks created, moved and deleted elsewhere are patched in by id,
 * and a block deleted elsewhere while edited here is kept as a new block.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  FakeBackend,
  idMinter,
  idsOf,
  openPage,
  PAGE,
  posIn,
  press,
  type Row,
  rowsOf,
  treeRows,
  type,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { createSaveState, type PageSaveState, savePage } from '@/editor/page-mode/page-save'
import { applyRemote } from '@/editor/page-mode/remote-patch'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const X = blockId(9)
const KEPT_1 = '01KEPT00000000000000000001'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

interface Page {
  ed: Editor
  backend: FakeBackend
  state: PageSaveState
  save: () => Promise<void>
  /** A change elsewhere, then the reread page mode patches from; resolves the blocks kept as new. */
  remote: (change: (backend: FakeBackend) => unknown) => Promise<number>
  /** A peer's edit of `id`, patched in. */
  remoteEdit: (id: string, markdown: string) => Promise<void>
}

function open(rows: Row[]): Page {
  const ed = openPage(rows)
  editor = ed
  const backend = new FakeBackend(rows)
  const state = createSaveState(PAGE, treeRows(rows), ed.state.doc)
  const mintKept = idMinter('01KEPT')
  const remote = async (change: (backend: FakeBackend) => unknown): Promise<number> => {
    await change(backend)
    return applyRemote(ed.view, state, await backend.tree(), mintKept).keptAsNew
  }
  return {
    ed,
    backend,
    state,
    save: async () => {
      await savePage(ed.state.doc, state, backend)
    },
    remote,
    remoteEdit: async (id, markdown) => {
      await remote((b) => b.edit(id, markdown))
    },
  }
}

describe('a block changed elsewhere', () => {
  it('shows the new text when page mode holds no unsaved edit of it, and saves nothing for it', async () => {
    const { ed, backend, save, remoteEdit } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])

    await remoteEdit(B, 'beta from a peer')
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 0, 'beta from a peer'],
    ])
    expect(backend.calls).toEqual([])
  })

  it('keeps the local text of a block edited here and not saved yet, which the next save writes', async () => {
    const { ed, backend, save, remoteEdit } = open([[A, 0, 'alpha']])
    caret(ed, 0, 5)
    type(ed, '!')

    await remoteEdit(A, 'alpha from a peer')
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'alpha!']])
    expect(backend.live()).toEqual([[A, 0, 'alpha!']])
  })

  it('shows the new text when the only change here moved the block, and saves the move', async () => {
    const { ed, backend, save, remoteEdit } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Tab')

    await remoteEdit(B, 'beta from a peer')
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 1, 'beta from a peer'],
    ])
    expect(backend.calls).toEqual([`move ${B}`])
    expect(backend.live()).toEqual([
      [A, 0, 'alpha'],
      [B, 1, 'beta from a peer'],
    ])
  })

  it('is patched again after its edit here was saved', async () => {
    const { ed, save, remoteEdit } = open([[A, 0, 'alpha']])
    caret(ed, 0, 5)
    type(ed, '!')
    await save()

    await remoteEdit(A, 'alpha! and more')

    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'alpha! and more']])
  })

  it('stays out of undo history: Ctrl+Z takes back the local edit, not the remote one', async () => {
    const { ed, save, remoteEdit } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    caret(ed, 0, 5)
    type(ed, '!')
    await save()
    await remoteEdit(B, 'beta from a peer')

    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 0, 'beta from a peer'],
    ])
  })

  it('keeps the cursor on the same text when the change is before it in the block', async () => {
    const { ed, remoteEdit } = open([[A, 0, 'one two three']])
    caret(ed, 0, 8)

    await remoteEdit(A, 'one 2 three')

    expect(ed.state.selection.from).toBe(posIn(ed, 0, 6))
    expect(ed.state.doc.textBetween(ed.state.selection.from, posIn(ed, 0, 11))).toBe('three')
  })
})

describe('blocks created, moved and deleted elsewhere', () => {
  it('a block created elsewhere shows where the backend put it, and saves nothing for it', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])

    await remote((b) => b.create(X, PAGE, 1, 'from a peer'))
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [X, 0, 'from a peer'],
      [B, 0, 'beta'],
    ])
    expect(backend.calls).toEqual([])
  })

  it('a child created elsewhere goes under its parent, after the children before it', async () => {
    const { ed, remote } = open([
      [A, 0, 'alpha'],
      [B, 1, 'beta'],
      [C, 0, 'gamma'],
    ])

    await remote((b) => b.create(X, A, 1, 'x'))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 1, 'beta'],
      [X, 1, 'x'],
      [C, 0, 'gamma'],
    ])
  })

  it('a block deleted elsewhere goes, with the blocks under it, and no save writes it', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])

    const kept = await remote((b) => b.remove(B))
    backend.reset()
    await save()

    expect(kept).toBe(0)
    expect(rowsOf(ed.state.doc)).toEqual([[A, 0, 'alpha']])
    expect(backend.calls).toEqual([])
  })

  it('a block deleted elsewhere while edited here keeps the text, as a new block the save creates', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    caret(ed, 1, 4)
    type(ed, ' typed')

    const kept = await remote((b) => b.remove(B))
    await save()

    expect(kept).toBe(1)
    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [KEPT_1, 0, 'beta typed'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
    expect(ed.state.selection.from).toBe(posIn(ed, 1, 'beta typed'.length))
  })

  it('a block under one deleted elsewhere, edited here, is kept and the rest of the subtree goes', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])
    caret(ed, 2, 5)
    type(ed, '!')

    await remote((b) => b.remove(B))
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [KEPT_1, 1, 'gamma!'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('a block moved out of a parent deleted in the same reload is moved here, and no save moves it back', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])

    await remote(async (b) => {
      await b.move(C, PAGE, 2)
      await b.remove(B)
    })
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [C, 0, 'gamma'],
    ])
    expect(backend.calls).toEqual([])
  })

  it('a block moved out of a parent deleted elsewhere while edited here is moved here, and no save moves it back', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])
    caret(ed, 1, 4)
    type(ed, '!')

    await remote(async (b) => {
      await b.move(C, PAGE, 2)
      await b.remove(B)
    })
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [C, 0, 'gamma'],
      [KEPT_1, 0, 'beta!'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('a block moved elsewhere moves here, with the blocks under it and the cursor in it', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
      [X, 0, 'last'],
    ])
    caret(ed, 2, 2)

    await remote((b) => b.move(B, PAGE, 2))
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [X, 0, 'last'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])
    expect(ed.state.selection.from).toBe(posIn(ed, 3, 2))
    expect(backend.calls).toEqual([])
  })

  it('a block indented elsewhere is indented here', async () => {
    const { ed, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])

    await remote((b) => b.move(B, A, 0))

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 1, 'beta'],
    ])
  })

  it('a block moved here and elsewhere, the move here not saved yet, stays where it was moved here', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
    ])
    caret(ed, 2, 0)
    press(ed, 'Tab')

    await remote((b) => b.move(C, PAGE, 0))
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 1, 'gamma'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('a block created or deleted beside a block moves no other block', async () => {
    const { ed, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
    ])

    await remote(async (b) => {
      await b.remove(A)
      await b.create(X, PAGE, 1, 'x')
    })

    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'beta'],
      [X, 0, 'x'],
      [C, 0, 'gamma'],
    ])
  })

  it('a block page mode deleted, brought back elsewhere, shows again and is not written', async () => {
    const { ed, backend, state, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    await save()
    const deletedAt = state.deletedAt.get(B) as number

    await remote((b) => b.restore(B, deletedAt))
    backend.reset()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alphabeta'],
      [B, 0, 'beta'],
    ])
    expect(backend.calls).toEqual([])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('a block whose create reached the backend but was reported failed is not created again', async () => {
    const { ed, backend, save, remote } = open([[A, 0, 'alpha']])
    caret(ed, 0, 5)
    press(ed, 'Enter')
    type(ed, 'new')
    const create = backend.create
    backend.create = async (...args) => {
      await create(...args)
      throw new Error('the answer was lost')
    }
    await save()
    backend.create = create

    await remote(() => undefined)
    backend.reset()
    await save()

    expect(backend.calls).toEqual([])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })
})

it('a page emptied elsewhere leaves one new, empty block, which the save does not create', async () => {
  const { ed, backend, save, remote } = open([
    [A, 0, 'alpha'],
    [B, 0, 'beta'],
  ])

  await remote(async (b) => {
    await b.remove(A)
    await b.remove(B)
  })
  backend.reset()
  await save()

  expect(rowsOf(ed.state.doc)).toEqual([['01NEW000000000000000000001', 0, '']])
  expect(backend.calls).toEqual([])
})

describe('what the property found', () => {
  it('a block a peer created under one deleted here, not saved yet, takes its place and survives the save', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')

    await remote((b) => b.create(X, B, 0, 'from a peer'))
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [A, 0, 'alphabeta'],
      [X, 0, 'from a peer'],
      [C, 0, 'gamma'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('an undo after a block was moved elsewhere brings back no copy of it', async () => {
    const { ed, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 0, 0), to: posIn(ed, 2, 0) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    ed.view.pasteHTML(data.getData('text/html'))
    await save()

    await remote((b) => b.move(A, PAGE, 3))
    ed.commands.undo()
    ed.commands.undo()

    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
      [A, 0, 'alpha'],
    ])
  })

  it('undoing a cut pasted where a block starts, after a peer created a block before it, gives each text its id back', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    // Pasted where A starts, B's text joins A's under B's id, and A's id goes.
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 1, 4) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    caret(ed, 0, 0)
    ed.view.pasteHTML(data.getData('text/html'))
    await save()

    await remote((b) => b.create(X, PAGE, 0, 'from a peer'))
    ed.commands.undo()
    ed.commands.undo()
    await save()

    expect(rowsOf(ed.state.doc)).toEqual([
      [X, 0, 'from a peer'],
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('an undo restoring a block whose parent a peer deleted leaves that parent deleted', async () => {
    const { ed, backend, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 1, 'beta'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    await save()
    ed.commands.undo()

    await remote((b) => b.remove(A))
    await save()

    expect(backend.live().map(([id]) => id)).not.toContain(A)
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('a copy pasted after a peer deleted its original, refused under that id, is saved under a new one', async () => {
    const { ed, backend, state, save, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 1, 4) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    await remote((b) => b.remove(B))
    caret(ed, 0, 0)
    ed.view.pasteHTML(data.getData('text/html'))
    const refused = await savePage(ed.state.doc, state, backend)
    expect(refused.failed).toMatchObject({ kind: 'create', id: B })

    applyRemote(ed.view, state, await backend.tree(), idMinter('01KEPT'), new Set([B]))
    await save()

    expect(idsOf(ed.state.doc)).not.toContain(B)
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })

  it('with a refused create, every block still to be created is saved under a new id, not one per save', async () => {
    const { ed, backend, state, remote } = open([
      [A, 0, 'alpha'],
      [B, 0, 'beta'],
      [C, 0, 'gamma'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 2, 'gamma'.length) })
    const data = new DataTransfer()
    ed.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    await remote(async (b) => {
      await b.remove(B)
      await b.remove(C)
    })
    caret(ed, 0, 0)
    ed.view.pasteHTML(data.getData('text/html'))
    const refused = await savePage(ed.state.doc, state, backend)
    expect(refused.failed).toMatchObject({ kind: 'create' })
    const { id } = refused.failed as { id: string }

    applyRemote(ed.view, state, await backend.tree(), idMinter('01KEPT'), new Set([id]))
    const retried = await savePage(ed.state.doc, state, backend)

    expect(retried.error).toBeUndefined()
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })
})
