/**
 * Page mode's keys (#5691). Enter in a block's own paragraph or heading splits
 * the block; Backspace at its start joins its text to the block before, and
 * Delete at its end joins the next one's. Tab and Shift+Tab move a block and
 * the blocks under it a level in or out. Arrows cross blocks on their own: the
 * page is one editable surface. Inside a list, a table or a code block the
 * keys keep their meaning there, and an open picker keeps its own keys.
 */

import { Extension } from '@tiptap/core'
import { joinTextblockBackward, joinTextblockForward } from '@tiptap/pm/commands'
import type { Node as PMNode, NodeType, ResolvedPos } from '@tiptap/pm/model'
import type { Command, EditorState } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'

import { atTagPickerPluginKey, hashTagPickerPluginKey } from '@/editor/extensions/at-tag-picker'
import { blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { blockRefPickerPluginKey } from '@/editor/extensions/block-ref-picker'
import { depthOf, PAGE_BLOCK } from '@/editor/page-mode/page-document'

const pickerKeys = [
  atTagPickerPluginKey,
  hashTagPickerPluginKey,
  blockLinkPickerPluginKey,
  blockRefPickerPluginKey,
]

/** Whether a picker is open in `state`: its Enter, Tab and Escape are its own. */
function pickerOpen(state: EditorState): boolean {
  return pickerKeys.some(
    (key) => (key.getState(state) as { active?: boolean } | undefined)?.active === true,
  )
}

/** Whether `$pos` sits in one of its block's own textblocks, not one inside a list or table. */
function inOwnTextblock($pos: ResolvedPos): boolean {
  return $pos.depth === 2 && $pos.parent.isTextblock && $pos.node(1).type.name === PAGE_BLOCK
}

function insideListOrTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 1; depth -= 1) {
    const role = $pos.node(depth).type.spec['tableRole'] as string | undefined
    if ($pos.node(depth).type.name === 'listItem' || role !== undefined) return true
  }
  return false
}

/** Enter: split the block at the cursor; past a heading's end the new block is a paragraph. */
export const splitPageBlock: Command = (state, dispatch) => {
  const tr = state.tr
  if (!tr.selection.empty) tr.deleteSelection()
  const { $from } = tr.selection
  if (!inOwnTextblock($from) || $from.parent.type.spec.code === true) return false
  const atEnd = $from.parentOffset === $from.parent.content.size
  const paragraph = state.schema.nodes['paragraph'] as NodeType
  const typesAfter = [
    { type: $from.node(1).type, attrs: { blockId: null, depth: depthOf($from.node(1)) } },
    atEnd ? { type: paragraph } : null,
  ]
  if (!canSplit(tr.doc, $from.pos, 2, typesAfter)) return false
  dispatch?.(tr.split($from.pos, 2, typesAfter).scrollIntoView())
  return true
}

/** The index of the block `pos` is in. */
function blockIndexAt(doc: PMNode, pos: number): number {
  return doc.resolve(pos).index(0)
}

/** The index past the last block under the block at `index`. */
function subtreeEnd(doc: PMNode, index: number): number {
  const depth = depthOf(doc.child(index))
  let end = index + 1
  while (end < doc.childCount && depthOf(doc.child(end)) > depth) end += 1
  return end
}

/**
 * Tab (`by` 1) or Shift+Tab (`by` -1): move the selected blocks, and the
 * blocks under them, one level. The first block goes in only under a block
 * before it at its own depth or deeper, and out only from below the top.
 */
export function shiftDepth(by: 1 | -1): Command {
  return (state, dispatch) => {
    const { doc, selection } = state
    const first = blockIndexAt(doc, selection.from)
    const end = subtreeEnd(doc, blockIndexAt(doc, selection.to))
    const firstDepth = depthOf(doc.child(first))
    const room =
      by === 1 ? first > 0 && depthOf(doc.child(first - 1)) >= firstDepth : firstDepth > 0
    if (!room) return true
    if (dispatch) {
      const tr = state.tr
      doc.forEach((node, at, i) => {
        if (i >= first && i < end) tr.setNodeAttribute(at, 'depth', Math.max(0, depthOf(node) + by))
      })
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** Backspace at the start of a block's first textblock: join it to the text before. */
const joinBackward: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || !inOwnTextblock($from) || $from.parentOffset !== 0 || $from.index(1) !== 0) {
    return false
  }
  if ($from.index(0) === 0) return false
  return joinTextblockBackward(state, dispatch, view)
}

/** Delete at the end of a block's last textblock: join the next block's text to it. */
const joinForward: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || !inOwnTextblock($from)) return false
  const atEnd = $from.parentOffset === $from.parent.content.size
  if (!atEnd || $from.index(1) !== $from.node(1).childCount - 1) return false
  if ($from.index(0) === state.doc.childCount - 1) return false
  return joinTextblockForward(state, dispatch, view)
}

export const PageKeys = Extension.create({
  name: 'pageKeys',
  // Ahead of the base keymap and the list, table and code-block keys.
  priority: 1000,
  addKeyboardShortcuts() {
    const run =
      (command: Command, when: (state: EditorState) => boolean = () => true) =>
      () => {
        const { state, view } = this.editor
        if (pickerOpen(state) || !when(state)) return false
        return command(state, view.dispatch, view)
      }
    const notInListOrTable = (state: EditorState) => !insideListOrTable(state.selection.$from)
    return {
      Enter: run(splitPageBlock),
      Backspace: run(joinBackward),
      Delete: run(joinForward),
      Tab: run(shiftDepth(1), notInListOrTable),
      'Shift-Tab': run(shiftDepth(-1), notInListOrTable),
    }
  },
})
