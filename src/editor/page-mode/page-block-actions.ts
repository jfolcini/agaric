/**
 * What page mode's block menu does to the document (#5972): each structural
 * row of block mode's menu, as a command on the blocks it names by id, not on
 * the selection. The document owns structure, so these edit it and the save
 * writes the result, as it writes a key's.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { type Command, type EditorState, TextSelection } from '@tiptap/pm/state'

import {
  firstTokenPos,
  restoreSelection,
  selectionEnds,
  startOf,
} from '@/editor/page-mode/page-document'
import { applyRows, joinBackward, treeRows } from '@/editor/page-mode/page-keys'
import { blockIdOf } from '@/editor/token-ids'
import { announce } from '@/lib/announcer'
import { findPrevSiblingAt } from '@/lib/block-tree-ops'
import { t } from '@/lib/i18n'
import type { TreeItem } from '@/lib/tree-utils'

/** The index one past the last block under the block at `index`. */
function subtreeEnd(rows: readonly TreeItem[], index: number): number {
  const depth = (rows[index] as TreeItem).depth
  let end = index + 1
  while (end < rows.length && (rows[end] as TreeItem).depth > depth) end += 1
  return end
}

/** `range` one level out, its first block under `parentId`. */
function shallower(range: readonly TreeItem[], parentId: string | null): TreeItem[] {
  return range.map((row, i) => ({
    ...row,
    depth: row.depth - 1,
    parent_id: i === 0 ? parentId : row.parent_id,
  }))
}

/**
 * The page as block mode's `moveUp` or `moveDown` leaves it: the block and
 * the blocks under it swap with the sibling before or after, and a first or
 * last child leaves its parent for the place before or after it (#922). Null
 * where the block stays.
 */
function movedRows(rows: readonly TreeItem[], id: string, direction: -1 | 1): TreeItem[] | null {
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return null
  const block = rows[index] as TreeItem
  const end = subtreeEnd(rows, index)
  const range = rows.slice(index, end)
  const rest = [...rows.slice(0, index), ...rows.slice(end)]
  const parent = rows.find((row) => row.id === block.parent_id)
  const popOut = (before: boolean): TreeItem[] | null => {
    if (parent === undefined) return null
    const out = shallower(range, parent.parent_id)
    if (!before) return [...rows.slice(0, index), ...out, ...rows.slice(end)]
    const at = rest.findIndex((row) => row.id === parent.id)
    return [...rest.slice(0, at), ...out, ...rest.slice(at)]
  }
  if (direction < 0) {
    const previous = findPrevSiblingAt(rows, index)
    if (previous === null) return popOut(true)
    const at = rest.findIndex((row) => row.id === previous.id)
    return [...rest.slice(0, at), ...range, ...rest.slice(at)]
  }
  const next = rows[end]
  if (next === undefined || next.depth < block.depth) return popOut(false)
  const after = subtreeEnd(rows, end) - range.length
  return [...rest.slice(0, after), ...range, ...rest.slice(after)]
}

/** Move each of `ids` one place up or down, the first first going up, the last first going down. */
export const moveBlocks =
  (ids: readonly string[], direction: -1 | 1): Command =>
  (state, dispatch) => {
    const tr = state.tr
    const ends = selectionEnds(state.doc, state.selection)
    let moved = false
    for (const id of direction < 0 ? ids : ids.toReversed()) {
      const rows = movedRows(treeRows(tr.doc), id, direction)
      if (rows === null) continue
      applyRows(tr, rows)
      moved = true
    }
    if (dispatch) {
      announce(
        t(
          moved
            ? direction < 0
              ? 'announce.blockMovedUp'
              : 'announce.blockMovedDown'
            : 'announce.moveFailed',
        ),
      )
      if (moved) dispatch(restoreSelection(tr, ends).scrollIntoView())
    }
    return true
  }

/** The `[start, end)` positions of the block `id` and the blocks under it, or null. */
function subtreeRange(doc: PMNode, id: string): { start: number; end: number } | null {
  const rows = treeRows(doc)
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return null
  return { start: startOf(doc, index), end: startOf(doc, subtreeEnd(rows, index)) }
}

/** A copy of the block `id` with the blocks under it, right after them, at the same depth, each with no id yet. */
export const duplicateBlock =
  (id: string): Command =>
  (state, dispatch) => {
    const range = subtreeRange(state.doc, id)
    if (range === null) return false
    const copies: PMNode[] = []
    state.doc.slice(range.start, range.end).content.forEach((node) => {
      copies.push(node.type.create({ ...node.attrs, blockId: null }, node.content))
    })
    dispatch?.(state.tr.insert(range.end, copies).scrollIntoView())
    return true
  }

/** Delete each of `ids` with the blocks under it; a block already gone with its parent is skipped. */
export const deleteBlocks =
  (ids: readonly string[]): Command =>
  (state, dispatch) => {
    const tr = state.tr
    let deleted = false
    for (const id of ids) {
      const range = subtreeRange(tr.doc, id)
      if (range === null) continue
      tr.delete(range.start, range.end)
      deleted = true
    }
    if (!deleted) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }

/** The state with the cursor at the start of block `id`, or null. */
function atStartOf(state: EditorState, id: string): EditorState | null {
  let at = -1
  state.doc.forEach((node, pos) => {
    if (at === -1 && blockIdOf(node) === id) at = pos
  })
  const node = at === -1 ? null : state.doc.nodeAt(at)
  if (node === null) return null
  const pos = firstTokenPos(node, at)
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
}

/** Whether `mergeBlock` would join the block `id` to the one before it. */
export function canMerge(state: EditorState, id: string): boolean {
  const there = atStartOf(state, id)
  return there !== null && joinBackward(there)
}

/** Backspace at the start of the block `id`: its text joins the block before, which keeps its id. */
export const mergeBlock =
  (id: string): Command =>
  (state, dispatch, view) => {
    const there = atStartOf(state, id)
    if (there === null) return false
    return joinBackward(there, dispatch, view)
  }

/** The id of each block in the `from`..`to` positions of `doc`, in order. */
export function blockIdsBetween(doc: PMNode, from: number, to: number): string[] {
  const ids: string[] = []
  const last = doc.resolve(to).index(0)
  for (let i = doc.resolve(from).index(0); i <= last && i < doc.childCount; i += 1) {
    ids.push(blockIdOf(doc.child(i)) as string)
  }
  return ids
}
