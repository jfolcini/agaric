/**
 * `changedBlocks` (#5743): which blocks a transaction's steps changed, over
 * real transactions of page mode's editor.
 */

import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import { blockId, openPage, posIn } from '@/editor/page-mode/__tests__/page-mode-fixtures'
import { changedBlocks, PAGE_BLOCK } from '@/editor/page-mode/page-document'

const A = blockId(1)
const B = blockId(2)
const C = blockId(3)
const X = blockId(4)

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(): Editor {
  editor = openPage([
    [A, 0, 'aaa'],
    [B, 0, 'bbb'],
    [C, 0, 'ccc'],
  ])
  return editor
}

describe('changedBlocks', () => {
  it('is the block typed in', () => {
    const ed = open()
    const tr = ed.state.tr.insertText('!', posIn(ed, 1, 1))

    expect([...changedBlocks(tr.doc, tr.mapping.maps)]).toEqual([B])
  })

  it('is a block inserted whole, not the block after it', () => {
    const ed = open()
    const { schema } = ed.state
    const whole = schema.nodes[PAGE_BLOCK]?.create(
      { blockId: X, depth: 0 },
      schema.nodes['paragraph']?.create(null, schema.text('xxx')),
    )
    const tr = ed.state.tr.insert(ed.state.doc.child(0).nodeSize, whole ?? [])

    expect([...changedBlocks(tr.doc, tr.mapping.maps)]).toEqual([X])
  })

  it('is no block when blocks are deleted whole', () => {
    const ed = open()
    const start = ed.state.doc.child(0).nodeSize
    const tr = ed.state.tr.delete(start, start + ed.state.doc.child(1).nodeSize)

    expect([...changedBlocks(tr.doc, tr.mapping.maps)]).toEqual([])
  })
})
