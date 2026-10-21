/**
 * Page mode's save, the cases the main suite leaves open (#5962): the state it
 * starts from, the plans over crafted states, which failure stops it, and the
 * saved state a restore's reread leaves.
 *
 * Equivalent mutants, accepted:
 * - `id === null` and `id !== null` in `createSaveState`: a block with no id
 *   finds no row, and every page block has an id.
 * - `parentId === undefined` and `at !== -1` in `detach`: a block in the tree
 *   is under a parent that lists it.
 * - `anchor === null` in `slotAfter`: no anchor is `-1`, which is slot 0 too.
 * - A stray entry in `previous` (`longestIncreasing`) or `atDepth`
 *   (`desiredBlocks`): each is read only after it is written; the first block
 *   is at depth 0.
 * - `row.content ?? ''` in `reread`'s `content`, and what `reread` saves for an
 *   ancestor: only that the ancestor is saved is read, as the save then
 *   deletes it, and the document does not show it.
 * - `id === null` in `desiredBlocks`: every page block has an id.
 * - `{ stopOnFailure: false }` made `{}`: `undefined` is as false.
 * - `op.kind === 'restore'` made true, and `restoring !== undefined` made true:
 *   the save plans again after each op, which runs the same writes.
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
import {
  createSaveState,
  desiredBlocks,
  longestIncreasing,
  type PageSaveApi,
  planCreates,
  planDeletes,
  planEdits,
  planMoves,
  savePage,
  type TreeRow,
} from '@/editor/page-mode/page-save'

vi.mock('@/editor/content-delta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/content-delta')>()
  return { ...actual, computeContentDelta: vi.fn(actual.computeContentDelta) }
})

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const D = blockId(4)
const NEW_1 = '01NEW000000000000000000001'
const NEW_2 = '01NEW000000000000000000002'

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(rows: Row[]) {
  const ed = openPage(rows)
  editor = ed
  const backend = new FakeBackend(rows)
  const state = createSaveState(PAGE, treeRows(rows), ed.state.doc)
  return { ed, backend, state, save: () => savePage(ed.state.doc, state, backend) }
}

function docOf(rows: Row[]) {
  editor = openPage(rows)
  return editor.state.doc
}

function stubApi(rows: TreeRow[]) {
  const calls: string[] = []
  const log = (call: string) => {
    calls.push(call)
    return Promise.resolve([])
  }
  const api: PageSaveApi = {
    create: (id) => log(`create ${id}`),
    restore: (id) => log(`restore ${id}`).then(() => undefined),
    move: (id) => log(`move ${id}`),
    edit: (id) => log(`edit ${id}`),
    remove: (id) => log(`delete ${id}`).then((refs) => ({ deletedAt: 1, refs })),
    tree: () => Promise.resolve(rows),
  }
  return { api, calls }
}

describe('the state a save starts from', () => {
  it('holds the blocks the rows hold, with an empty text for a row with none', () => {
    const doc = docOf([
      [A, 0, ''],
      [B, 0, 'b'],
    ])

    const state = createSaveState(PAGE, [{ id: A, parent_id: PAGE, content: null }], doc)

    expect([...state.saved].map(([id, saved]) => [id, saved.markdown])).toEqual([[A, '']])
  })

  it('takes a longest run that rises strictly', () => {
    expect(longestIncreasing([2, 2]).size).toBe(1)
  })
})

describe('the plans', () => {
  it('a new block goes after the nearest block before it that is under its own parent', () => {
    const rows: Row[] = [
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 1, 'c'],
    ]
    const doc = docOf([rows[0] as Row, rows[1] as Row, [C, 2, 'c'], [D, 1, 'd']])
    const state = createSaveState(PAGE, treeRows(rows), doc)

    const ops = planCreates(desiredBlocks(doc, state), state)

    expect(ops.map((op) => (op.kind === 'create' ? [op.id, op.parentId, op.index] : op))).toEqual([
      [D, A, 1],
    ])
  })

  it('skips a sibling before it that is not in the tree yet', () => {
    const doc = docOf([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 1, 'c'],
      [D, 1, 'd'],
    ])
    const state = createSaveState(
      PAGE,
      treeRows([
        [A, 0, 'a'],
        [B, 1, 'b'],
      ]),
      doc,
    )
    state.deletedAt.set(C, 1)

    const ops = planCreates(desiredBlocks(doc, state), state)

    expect(ops.map((op) => (op.kind === 'create' ? op.index : op.kind))).toEqual(['restore', 1])
  })

  it('moves no block under one the backend does not hold, nor under a block still under it', () => {
    // C goes under a new block not created yet; B goes under C, which the backend holds under B.
    const doc = docOf([
      [A, 0, 'a'],
      [NEW_1, 0, 'new'],
      [C, 1, 'c'],
      [B, 2, 'b'],
    ])
    const state = createSaveState(
      PAGE,
      treeRows([
        [A, 0, 'a'],
        [B, 0, 'b'],
        [C, 1, 'c'],
      ]),
      doc,
    )

    expect(planMoves(desiredBlocks(doc, state), state)).toEqual([])
  })

  it('edits no block it never saved', () => {
    const doc = docOf([[A, 0, 'a']])
    const state = createSaveState(PAGE, [], doc)

    expect(planEdits(desiredBlocks(doc, state), state)).toEqual([])
  })

  it('deletes a saved block the tree does not know', () => {
    const state = createSaveState(PAGE, [], docOf([[A, 0, 'a']]))
    state.saved.set(B, { node: null, markdown: '' })

    expect(planDeletes([], state)).toEqual([{ kind: 'delete', id: B }])
  })
})

describe('what a save leaves', () => {
  it('keeps a block emptied of its text, and writes the edit', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    ed.commands.setTextSelection({ from: posIn(ed, 1, 0), to: posIn(ed, 1, 3) })
    ed.commands.deleteSelection()

    await save()

    expect(backend.calls).toEqual([`edit ${B}`])
    expect(backend.live()[1]).toEqual([B, 0, ''])
  })

  it('a block the serialiser only canonicalises is settled: no write, no refs, and not compared again', async () => {
    const { ed, state, save } = open([[A, 0, 'plain']])
    caret(ed, 0, 0)
    press(ed, 'Tab')
    ed.view.dispatch(ed.state.tr.setNodeAttribute(0, 'depth', 0))

    const settled = await save()
    vi.mocked(computeContentDelta).mockClear()
    await save()

    expect([settled.refs, settled.structural, state.writes]).toEqual([[], false, 0])
    expect(vi.mocked(computeContentDelta)).not.toHaveBeenCalled()
  })

  it('a restore adds no refs of its own', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Backspace')
    await save()
    ed.commands.undo()

    const result = await save()

    expect(result.refs).toHaveLength(1)
    expect(backend.live()).toEqual([
      [A, 0, 'foo'],
      [B, 0, 'bar'],
    ])
  })

  it('a block cut with its child and brought back by an undo is restored once', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    ed.view.dispatch(ed.state.tr.delete(0, posIn(ed, 2, 0) - 2))
    await save()
    backend.reset()

    ed.commands.undo()
    const result = await save()

    expect(result.error).toBeUndefined()
    expect(backend.calls).toEqual([`restore ${A}`, 'tree'])
  })

  it('forgets a deleted block and the blocks under it', async () => {
    const { ed, state, save } = open([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 0, 'c'],
    ])
    ed.view.dispatch(ed.state.tr.delete(0, posIn(ed, 2, 0) - 2))

    await save()

    expect([...state.tree.parentOf.keys()]).toEqual([C])
    expect([...state.tree.children.keys()]).toEqual([PAGE])
  })
})

describe('which failure stops a save', () => {
  it('a failed create leaves the creates after it that do not need it, and the first failure the one reported', async () => {
    const { ed, backend, save } = open([[A, 0, 'a']])
    caret(ed, 0, 1)
    press(ed, 'Enter')
    type(ed, 'x')
    press(ed, 'Enter')
    type(ed, 'y')
    backend.failing = (kind) => kind === 'create'

    const result = await save()

    expect(backend.calls).toEqual([`create ${NEW_1}`, `create ${NEW_2}`])
    expect(result.failed?.id).toBe(NEW_1)
  })

  it('a failed move stops the moves after it', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    caret(ed, 1, 0)
    press(ed, 'Tab')
    caret(ed, 2, 0)
    press(ed, 'Tab')
    backend.failing = (kind) => kind === 'move'

    await save()

    expect(backend.calls).toEqual([`move ${B}`])
  })

  it('a failed edit leaves the edits after it written, and the first failure the one reported', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
    ])
    caret(ed, 0, 1)
    type(ed, '!')
    caret(ed, 1, 1)
    type(ed, '!')
    backend.failing = (kind) => kind === 'edit'

    const result = await save()

    expect(backend.calls).toEqual([`edit ${A}`, `edit ${B}`])
    expect(result.failed?.id).toBe(A)
  })

  it('a failed delete leaves the deletes after it written', async () => {
    const { ed, backend, save } = open([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 0, 'c'],
    ])
    ed.view.dispatch(ed.state.tr.delete(posIn(ed, 1, 0) - 2, ed.state.doc.content.size))
    backend.failing = (kind, id) => kind === 'delete' && id === B

    await save()

    expect(backend.calls).toEqual([`delete ${B}`, `delete ${C}`])
  })
})

describe('what a restore’s reread saves', () => {
  const peer: TreeRow = { id: D, parent_id: PAGE, content: 'peer' }

  it('leaves a block of the peer’s that the restored block sits under unsaved', async () => {
    const doc = docOf([[C, 0, 'c']])
    const state = createSaveState(PAGE, [], doc)
    state.tree = createSaveState(PAGE, [peer], doc).tree
    state.deletedAt.set(C, 7)
    const { api, calls } = stubApi([peer, { id: C, parent_id: D, content: 'c' }])

    await savePage(doc, state, api)

    expect(calls).toEqual([`restore ${C}`, `move ${C}`])
  })

  it('leaves the saved state of a block it did not restore as it was', async () => {
    const doc = docOf([
      [A, 0, 'a'],
      [C, 1, 'c'],
    ])
    const rows: Row[] = [
      [A, 0, 'a'],
      [C, 1, 'c'],
    ]
    const state = createSaveState(PAGE, treeRows(rows), doc)
    state.saved.delete(C)
    state.deletedAt.set(C, 3)
    vi.mocked(computeContentDelta).mockClear()

    await savePage(doc, state, stubApi(treeRows(rows)).api)

    expect(vi.mocked(computeContentDelta)).toHaveBeenCalledTimes(1)
  })

  it('saves a restored block with no content as empty, so an empty block writes no edit', async () => {
    const doc = docOf([
      [A, 0, 'a'],
      [C, 1, ''],
    ])
    const state = createSaveState(PAGE, treeRows([[A, 0, 'a']]), doc)
    state.deletedAt.set(C, 3)
    const { api, calls } = stubApi([
      { id: A, parent_id: PAGE, content: 'a' },
      { id: C, parent_id: A, content: null },
    ])

    await savePage(doc, state, api)

    expect(calls).toEqual([`restore ${C}`])
  })
})
