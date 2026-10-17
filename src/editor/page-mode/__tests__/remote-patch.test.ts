/**
 * Page mode after the page store reloads (#5691): a block changed elsewhere
 * is patched in when page mode holds no unsaved edit of it, outside undo
 * history and with the cursor mapped; a block with one keeps the local text.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  FakeBackend,
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
import { adoptPatched, remotePatch } from '@/editor/page-mode/remote-patch'

const A = blockId(1)
const B = blockId(2)

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
  /** A peer's edit of `id`, then the store's reload that page mode patches from. */
  remoteEdit: (id: string, markdown: string) => Promise<void>
}

function open(rows: Row[]): Page {
  const ed = openPage(rows)
  editor = ed
  const backend = new FakeBackend(rows)
  const state = createSaveState(PAGE, treeRows(rows), ed.state.doc)
  return {
    ed,
    backend,
    state,
    save: async () => {
      await savePage(ed.state.doc, state, backend)
    },
    remoteEdit: async (id, markdown) => {
      await backend.edit(id, markdown)
      const patch = remotePatch(ed.state, state, await backend.tree())
      if (patch === null) return
      ed.view.dispatch(patch.tr)
      adoptPatched(ed.state.doc, state, patch.patched)
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
