/**
 * Page mode's current block (#5691): while the document has focus, the block
 * holding the cursor wears block mode's editing box (`page-block-current`).
 * Built from the selection alone, never by walking the document.
 */

import { Extension } from '@tiptap/core'
import { type EditorState, Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

function currentBlock(state: EditorState): DecorationSet {
  const { $head } = state.selection
  if ($head.depth < 1) return DecorationSet.empty
  const start = $head.before(1)
  return DecorationSet.create(state.doc, [
    Decoration.node(start, start + $head.node(1).nodeSize, { class: 'page-block-current' }),
  ])
}

export const PageBlockFocus = Extension.create({
  name: 'pageBlockFocus',
  addProseMirrorPlugins() {
    const { editor } = this
    return [
      new Plugin({
        props: {
          // TipTap redraws on each focus and blur with a transaction of its own.
          decorations: (state) => (editor.isFocused ? currentBlock(state) : null),
        },
      }),
    ]
  },
})
