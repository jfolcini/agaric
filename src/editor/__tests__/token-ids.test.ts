/**
 * The id rules `source-buffer.ts` and page mode share (`token-ids.ts`), over a
 * bare schema of blocks holding text, a block's first token at its first
 * character and its last at its last.
 *
 * Equivalent mutants, accepted:
 * - `id === null` in `takenIds` dropped: a block with no id would put `null`
 *   in the set of taken ids, which no block ever keeps, as `idsAfter` reads
 *   `null` as no id.
 * - `kept !== null` in `idsAfter` made true: it pushes the `null` it holds.
 * - `id === null` in `withPageIds` made false: a block with no id is made again
 *   with no id.
 */

import { Fragment, type NodeType, Schema, Slice } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'

import { idsAfter, pasteKeepingIds, type Tokens } from '@/editor/token-ids'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    block: { content: 'text*', attrs: { blockId: { default: null } } },
    text: {},
  },
})

const tokens: Tokens = {
  first: (_node, offset) => offset + 1,
  last: (node, offset) => offset + Math.max(1, node.content.size),
}

function block(id: string | null, text: string) {
  return (schema.nodes['block'] as NodeType).create(
    { blockId: id },
    text === '' ? [] : schema.text(text),
  )
}

function stateOf(blocks: Array<ReturnType<typeof block>>) {
  return EditorState.create({ doc: (schema.nodes['doc'] as NodeType).create(null, blocks) })
}

describe('idsAfter', () => {
  it('leaves a cut block’s id off the block that replaced it', () => {
    const state = stateOf([block('A', 'ab'), block('B', 'cd')])
    const tr = state.tr.replaceWith(0, 4, block('A', 'xy')).setMeta('uiEvent', 'cut')

    expect(idsAfter([tr], state.doc, tr.doc, tokens)).toEqual([null, 'B'])
  })

  it('gives a block with no id the id its attribute was set to', () => {
    const state = stateOf([block(null, 'ab')])
    const tr = state.tr.setNodeAttribute(0, 'blockId', 'X')

    expect(idsAfter([tr], state.doc, tr.doc, tokens)).toEqual(['X'])
  })

  it('leaves the id of a one-token block a cut did not take, though text went in after it', () => {
    const state = stateOf([block('A', 'a')])
    const tr = state.tr.insertText('x', 2).setMeta('uiEvent', 'cut')

    expect(idsAfter([tr], state.doc, tr.doc, tokens)).toEqual(['A'])
  })

  it('leaves a block its id when a cut took its last token and not its first, though text went in before it', () => {
    const state = stateOf([block('A', 'abc')])
    const tr = state.tr.delete(2, 4).insertText('zz', 1).setMeta('uiEvent', 'cut')

    expect(idsAfter([tr], state.doc, tr.doc, tokens)).toEqual(['A'])
  })

  it('counts a cut in any of the transactions', () => {
    const state = stateOf([block('A', 'ab'), block('B', 'cd')])
    const cut = state.tr.replaceWith(0, 4, block('A', 'xy')).setMeta('uiEvent', 'cut')
    const next = state.apply(cut)
    const typed = next.tr.insertText('z', 5)

    expect(idsAfter([cut, typed], state.doc, typed.doc, tokens)).toEqual([null, 'B'])
  })

  it('gives an id held by two blocks that no block started with to the first only', () => {
    const state = stateOf([block('A', 'xy')])
    const tr = state.tr.replaceWith(0, 4, [block('Q', 'm'), block('Q', 'n')])

    expect(idsAfter([tr], state.doc, tr.doc, tokens)).toEqual(['Q', null])
  })
})

describe('pasteKeepingIds', () => {
  it('sets no id from a slice that is whole blocks, none opening a block, leaving them theirs', () => {
    const state = stateOf([block('A', 'xy')])
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 1))
    const slice = new Slice(Fragment.from(block('Q', 'm')), 0, 0)

    const pasted = pasteKeepingIds(tr, slice, true)

    expect(pasted.doc.children.map((node) => node.attrs['blockId'])).toEqual(['Q', 'A'])
  })
})
