/**
 * Page mode's current block (#5691): while the document has focus, the block
 * holding the cursor wears block mode's editing box (`page-block-current`),
 * and shows its grip and chevron as block mode's focused row does
 * (`block-active`). Built from the selection alone, never by walking the
 * document. A node view reads it from its decorations (`isCurrentBlock`).
 */

import { Extension } from '@tiptap/core'
import { type EditorState, Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const CURRENT = { pageBlockCurrent: true }

function currentBlock(state: EditorState): DecorationSet {
  const { $head } = state.selection
  if ($head.depth < 1) return DecorationSet.empty
  const start = $head.before(1)
  return DecorationSet.create(state.doc, [
    Decoration.node(
      start,
      start + $head.node(1).nodeSize,
      { class: 'page-block-current block-active' },
      CURRENT,
    ),
  ])
}

/** Whether a block's node decorations make it the current block. */
export function isCurrentBlock(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => decoration.spec === CURRENT)
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
