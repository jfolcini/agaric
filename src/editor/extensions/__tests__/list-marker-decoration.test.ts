/**
 * Tests for the #3000 ListMarkerDecoration plugin — the focused-block list
 * marker fed as external state (not from the document). Exercises the plugin's
 * state machine and the decoration it produces on a minimal ProseMirror schema.
 */

import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'

import {
  buildDecorations,
  createListMarkerPlugin,
  listMarkerPluginKey,
  setListMarkerMeta,
  type ListMarkerState,
} from '@/editor/extensions/list-marker-decoration'

// Minimal schema: a doc of blocks, a textblock paragraph, a leaf code_block
// (NOT a textblock-with-inline for the "non-textblock first child" case), text.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    // A leaf, non-textblock node to exercise the "first child not a textblock"
    // guard (like a horizontal rule).
    hr: { group: 'block' },
    text: {},
  },
})

function stateWith(docJson: unknown): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON(docJson as never),
    plugins: [createListMarkerPlugin()],
  })
}

const paraDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
}

/** Apply a marker-state meta and return the resulting state. */
function withMarker(state: EditorState, marker: ListMarkerState): EditorState {
  return state.apply(setListMarkerMeta(state.tr, marker))
}

describe('ListMarkerDecoration plugin state', () => {
  it('initialises to none', () => {
    const state = stateWith(paraDoc)
    expect(listMarkerPluginKey.getState(state)).toEqual({ style: 'none', ordinal: undefined })
  })

  it('adopts the marker set via setMeta and preserves it across unrelated txns', () => {
    let state = withMarker(stateWith(paraDoc), { style: 'ordered', ordinal: 3 })
    expect(listMarkerPluginKey.getState(state)).toEqual({ style: 'ordered', ordinal: 3 })
    // A plain doc transaction (no marker meta) must keep the marker.
    state = state.apply(state.tr.insertText('!', 1))
    expect(listMarkerPluginKey.getState(state)).toEqual({ style: 'ordered', ordinal: 3 })
  })
})

describe('ListMarkerDecoration decorations', () => {
  it('produces no decoration for a none block', () => {
    expect(buildDecorations(stateWith(paraDoc)).find()).toHaveLength(0)
  })

  it('produces one widget at the first textblock start for bullet/ordered', () => {
    const state = withMarker(stateWith(paraDoc), { style: 'bullet', ordinal: undefined })
    const found = buildDecorations(state).find()
    expect(found).toHaveLength(1)
    // Widget anchored at position 1 (inside the first block, before its text).
    expect(found[0]?.from).toBe(1)
  })

  it('produces no decoration when the first block is not a textblock', () => {
    const hrDoc = { type: 'doc', content: [{ type: 'hr' }] }
    const state = withMarker(stateWith(hrDoc), { style: 'bullet', ordinal: undefined })
    expect(buildDecorations(state).find()).toHaveLength(0)
  })
})
