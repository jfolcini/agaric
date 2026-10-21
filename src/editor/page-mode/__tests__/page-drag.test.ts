/**
 * Page mode's drag (#5691): where a block dragged by its grip lands
 * (`dropTarget`, block mode's projection), what the drop does to the document
 * (`dropBlock`: the block with the blocks under it), and that the save writes
 * it as the block commands' moves. The pointer itself is Playwright's
 * (`e2e/page-mode-gutter.spec.ts`).
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  blockId,
  caret,
  FakeBackend,
  idMinter,
  openPage,
  PAGE,
  type Row,
  rowsOf,
  treeRows,
} from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { dropBlock } from '@/editor/page-mode/page-block-actions'
import { toggleFold } from '@/editor/page-mode/page-collapse'
import { dropTarget } from '@/editor/page-mode/page-drag'
import { createSaveState, savePage } from '@/editor/page-mode/page-save'
import { DEAD_ZONE_PX, MAX_BLOCK_DEPTH } from '@/lib/tree-utils'

const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(blockId) as [string, string, string, string, string]
const INDENT = 24

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function build(rows: Row[]): Editor {
  editor = openPage(rows, idMinter())
  return editor
}

const shape = (ed: Editor) => rowsOf(ed.state.doc).map(([id, depth]) => [id, depth])

describe('dropBlock', () => {
  const ROWS: Row[] = [
    [A, 0, 'a'],
    [B, 0, 'b'],
    [C, 1, 'c'],
    [D, 2, 'd'],
    [E, 0, 'e'],
  ]

  it('moves the block with the blocks under it before the block at the slot, those as deep under it as they were', () => {
    const ed = build(ROWS)
    caret(ed, 4, 1)

    expect(dropBlock(B, 0, 0)(ed.state, ed.view.dispatch)).toBe(true)

    expect(rowsOf(ed.state.doc)).toEqual([
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 2, 'd'],
      [A, 0, 'a'],
      [E, 0, 'e'],
    ])
    // As block mode's drop focuses the block dragged.
    expect(ed.state.selection.$head.index(0)).toBe(0)
  })

  it('to the end, one level in, under the block it then follows', () => {
    const ed = build(ROWS)

    dropBlock(B, 5, 1)(ed.state, ed.view.dispatch)

    expect(shape(ed)).toEqual([
      [A, 0],
      [E, 0],
      [B, 1],
      [C, 2],
      [D, 3],
    ])
    expect(ed.state.selection.$head.index(0)).toBe(2)
  })

  it('among its own blocks, or just past them, only its depth can change', () => {
    const ed = build(ROWS)

    expect(dropBlock(B, 3, 0)(ed.state, ed.view.dispatch)).toBe(false)
    expect(dropBlock(B, 4, 0)(ed.state, ed.view.dispatch)).toBe(false)
    expect(shape(ed)).toEqual(ROWS.map(([id, depth]) => [id, depth]))

    expect(dropBlock(B, 2, 1)(ed.state, ed.view.dispatch)).toBe(true)
    expect(shape(ed)).toEqual([
      [A, 0],
      [B, 1],
      [C, 2],
      [D, 3],
      [E, 0],
    ])
  })

  it('is saved as one move of the block through the block commands, and the backend then holds the document', async () => {
    const ed = build(ROWS)
    const backend = new FakeBackend(ROWS)
    const save = createSaveState(PAGE, treeRows(ROWS), ed.state.doc)

    dropBlock(B, 5, 1)(ed.state, ed.view.dispatch)
    const result = await savePage(ed.state.doc, save, backend)

    expect(result.error).toBeUndefined()
    expect(backend.calls).toEqual([`move ${B}`])
    expect(backend.live()).toEqual(rowsOf(ed.state.doc))
  })
})

describe('dropTarget', () => {
  const FLAT: Row[] = [
    [A, 0, 'a'],
    [B, 0, 'b'],
    [C, 0, 'c'],
    [D, 0, 'd'],
  ]

  it('lands before the block under the pointer over its upper half, and after it over its lower half', () => {
    const ed = build(FLAT)

    expect(dropTarget(ed.state, 3, 1, false, 0, INDENT)).toEqual({ slot: 1, depth: 0 })
    expect(dropTarget(ed.state, 3, 1, true, 0, INDENT)).toEqual({ slot: 2, depth: 0 })
  })

  it('after a collapsed block is after what it hides', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
      [D, 0, 'd'],
      [E, 0, 'e'],
    ])
    caret(ed, 4, 0)
    toggleFold(A)(ed.state, ed.view.dispatch)

    expect(dropTarget(ed.state, 4, 0, true, 0, INDENT)).toEqual({ slot: 3, depth: 0 })
    // One level in goes under the collapsed block, not under what it hides.
    expect(dropTarget(ed.state, 4, 0, true, 500, INDENT)).toEqual({ slot: 3, depth: 1 })
  })

  it('over its own blocks, or just past them, is where it is', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 0, 'b'],
      [C, 1, 'c'],
      [D, 0, 'd'],
    ])

    expect(dropTarget(ed.state, 1, 2, false, 0, INDENT)).toEqual({ slot: 1, depth: 0 })
    expect(dropTarget(ed.state, 1, 2, true, 0, INDENT)).toEqual({ slot: 1, depth: 0 })
    expect(dropTarget(ed.state, 1, 3, false, 0, INDENT)).toEqual({ slot: 1, depth: 0 })
  })

  it('follows the pointer one level per indent past block mode’s dead zone, at most one deeper than the block before', () => {
    const ed = build(FLAT)
    const depthAt = (dx: number) => dropTarget(ed.state, 3, 1, true, dx, INDENT)?.depth

    expect(depthAt(DEAD_ZONE_PX)).toBe(0)
    expect(depthAt(DEAD_ZONE_PX + INDENT)).toBe(1)
    expect(depthAt(DEAD_ZONE_PX + INDENT * 5)).toBe(1)
    expect(depthAt(-500)).toBe(0)
  })

  it('never shallower than the block after it, which stays where it is', () => {
    const ed = build([
      [A, 0, 'a'],
      [B, 1, 'b'],
      [C, 2, 'c'],
      [D, 0, 'd'],
    ])

    expect(dropTarget(ed.state, 3, 1, true, -500, INDENT)).toEqual({ slot: 2, depth: 2 })
  })

  it('never so deep that its deepest block passes the backend’s deepest level', () => {
    const chain: Row[] = Array.from({ length: MAX_BLOCK_DEPTH }, (_, depth) => [
      blockId(10 + depth),
      depth,
      `level ${depth}`,
    ])
    const ed = build([...chain, [A, 0, 'a'], [B, 1, 'b'], [C, 2, 'c']])
    const from = MAX_BLOCK_DEPTH

    expect(dropTarget(ed.state, from, from - 1, true, 10_000, INDENT)?.depth).toBe(
      MAX_BLOCK_DEPTH - 3,
    )
  })

  it('drops nowhere when the dragged blocks are too tall to sit as deep as the block after, which would move in under them', () => {
    const height = 10
    const tall: Row[] = Array.from({ length: height + 1 }, (_, depth) => [
      blockId(100 + depth),
      depth,
      `tall ${depth}`,
    ])
    const deepest = MAX_BLOCK_DEPTH - height
    const deep: Row[] = Array.from({ length: deepest + 1 }, (_, depth) => [
      blockId(200 + depth),
      depth,
      `deep ${depth}`,
    ])
    const ed = build([...tall, ...deep])
    const last = tall.length + deepest

    expect(dropTarget(ed.state, 0, last, false, 0, INDENT)).toBeNull()
    // One level shallower, the dragged blocks fit.
    expect(dropTarget(ed.state, 0, last - 1, false, 0, INDENT)).toEqual({
      slot: last - 1,
      depth: deepest - 1,
    })
  })
})
