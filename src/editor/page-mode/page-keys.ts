/**
 * Page mode's keys (#5691). Enter in a block's own paragraph or heading splits
 * the block; Backspace at its start joins its text to the block before, and
 * Delete at its end joins the next one's. Tab and Shift+Tab move a block and
 * the blocks under it a level in or out, by block mode's own rules
 * (`block-tree-ops.ts`); with *Tab indents blocks* off, Tab is left to move
 * focus and the indent and dedent shortcuts do it, as in block mode. Arrows
 * cross blocks on their own: the page is one editable surface. Escape leaves
 * it, as it leaves a block. Inside a list, a table or a code block the keys
 * keep their meaning there, and an open picker keeps its own keys.
 */

import { Extension } from '@tiptap/core'
import { joinTextblockBackward, joinTextblockForward } from '@tiptap/pm/commands'
import type { Node as PMNode, NodeType, ResolvedPos } from '@tiptap/pm/model'
import { type Command, type EditorState, Plugin, type Transaction } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'

import { atTagPickerPluginKey, hashTagPickerPluginKey } from '@/editor/extensions/at-tag-picker'
import { blockLinkPickerPluginKey } from '@/editor/extensions/block-link-picker'
import { blockRefPickerPluginKey } from '@/editor/extensions/block-ref-picker'
import {
  depthOf,
  insideListOrTable,
  PAGE_BLOCK,
  restoreSelection,
  selectionEnds,
  startOf,
} from '@/editor/page-mode/page-document'
import { blockIdOf } from '@/editor/token-ids'
import { announce } from '@/lib/announcer'
import {
  computeDedentedBlocks,
  computeIndentedBlocks,
  findPrevSiblingAt,
  indentTooDeep,
} from '@/lib/block-tree-ops'
import { isTabIndentEnabled } from '@/lib/editor-preferences'
import { t } from '@/lib/i18n'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { notify } from '@/lib/notify'
import { computeSelectionRoots, type TreeItem } from '@/lib/tree-utils'

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

/** The page's blocks as the flat tree block mode's tree operations read (`block-tree-ops.ts`). */
function treeRows(doc: PMNode): TreeItem[] {
  const rows: TreeItem[] = []
  const atDepth: string[] = []
  doc.forEach((node) => {
    const id = blockIdOf(node) as string
    const depth = depthOf(node)
    rows.push({ id, depth, parent_id: depth === 0 ? null : (atDepth[depth - 1] ?? null) })
    atDepth[depth] = id
  })
  return rows
}

/** The blocks the selection spans, none under another of them: the ones Tab and Shift+Tab move. */
function selectedRoots(state: EditorState, rows: readonly TreeItem[]): string[] {
  const { doc, selection } = state
  const first = doc.resolve(selection.from).index(0)
  const last = doc.resolve(selection.to).index(0)
  return computeSelectionRoots(
    rows,
    rows.slice(first, last + 1).map((row) => row.id),
  )
}

/**
 * Make `tr`'s document hold `rows`, block mode's tree after one block's move:
 * the run of blocks that moved goes to its new place, and each block whose
 * depth changed gets its new depth as an attribute. Never more than that, so
 * an undo rebased past a change made elsewhere does not bring back copies.
 */
function applyRows(tr: Transaction, rows: readonly TreeItem[]): void {
  const now = treeRows(tr.doc)
  let i = 0
  while (i < rows.length && now[i]?.id === rows[i]?.id) i += 1
  if (i < rows.length) {
    // One run moved later: it starts where the orders first differ.
    const at = rows.findIndex((row) => row.id === now[i]?.id)
    let length = 0
    while (now[i + length]?.id === rows[at + length]?.id) length += 1
    const from = startOf(tr.doc, i)
    const nodes: PMNode[] = []
    for (let k = i; k < i + length; k += 1) nodes.push(tr.doc.child(k))
    tr.delete(from, startOf(tr.doc, i + length))
    tr.insert(startOf(tr.doc, at), nodes)
  }
  tr.doc.forEach((node, offset, index) => {
    const depth = rows[index]?.depth
    if (depth !== undefined && depthOf(node) !== depth) tr.setNodeAttribute(offset, 'depth', depth)
  })
}

/**
 * Tab: each selected block, with the blocks under it, moves in under the
 * sibling before it, as block mode's `indent` does: nothing past the backend's
 * deepest level, and a block with no sibling before it stays.
 */
export const indentBlocks: Command = (state, dispatch) => {
  const tr = state.tr
  const ends = selectionEnds(state.doc, state.selection)
  let moved = false
  for (const id of selectedRoots(state, treeRows(state.doc))) {
    const rows = treeRows(tr.doc)
    const prevSibling = findPrevSiblingAt(
      rows,
      rows.findIndex((row) => row.id === id),
    )
    if (prevSibling === null) continue
    if (indentTooDeep(rows, id, prevSibling)) {
      if (dispatch) notify.error(t('error.maxNestingReached'), { id: 'max-nesting-reached' })
      break
    }
    applyRows(tr, computeIndentedBlocks(rows, id, prevSibling))
    moved = true
  }
  if (dispatch) {
    announce(t(moved ? 'announce.blockIndented' : 'announce.moveFailed'))
    if (moved) dispatch(restoreSelection(tr, ends).scrollIntoView())
  }
  return true
}

/**
 * Shift+Tab: each selected block, with the blocks under it, moves out to just
 * after its parent's blocks, as block mode's `dedent` does (#400): the blocks
 * that followed it under the parent stay there.
 */
export const outdentBlocks: Command = (state, dispatch) => {
  const tr = state.tr
  const ends = selectionEnds(state.doc, state.selection)
  let moved = false
  for (const id of selectedRoots(state, treeRows(state.doc)).toReversed()) {
    const rows = treeRows(tr.doc)
    const parentId = rows.find((row) => row.id === id)?.parent_id ?? null
    if (parentId === null) continue
    const grandparent = rows.find((row) => row.id === parentId)?.parent_id ?? null
    applyRows(tr, computeDedentedBlocks(rows, id, parentId, grandparent))
    moved = true
  }
  if (dispatch) {
    announce(t(moved ? 'announce.blockDedented' : 'announce.moveFailed'))
    if (moved) dispatch(restoreSelection(tr, ends).scrollIntoView())
  }
  return true
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
    const tabIndents = (state: EditorState) =>
      !insideListOrTable(state.selection.$from) && isTabIndentEnabled()
    return {
      Enter: run(splitPageBlock),
      Backspace: run(joinBackward),
      Delete: run(joinForward),
      Tab: run(indentBlocks, tabIndents),
      'Shift-Tab': run(outdentBlocks, tabIndents),
      // As block mode's "leave block": out of the document, which saves it.
      Escape: run(() => this.editor.commands.blur()),
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // The rebindable shortcuts, which still indent where Tab is left to move focus.
          handleKeyDown(view, event) {
            let command: Command | null = null
            if (matchesShortcutBinding(event, 'indentBlock')) command = indentBlocks
            else if (matchesShortcutBinding(event, 'dedentBlock')) command = outdentBlocks
            if (command === null || pickerOpen(view.state)) return false
            return command(view.state, view.dispatch, view)
          },
        },
      }),
    ]
  },
})
