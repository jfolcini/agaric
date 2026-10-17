/**
 * Page mode after a change made elsewhere (#5691): a peer, MCP, another view,
 * a page-level undo. `rows` is the page as the backend now holds it, read after
 * page mode's own writes; `save` is what page mode last knew it held. Each
 * block is brought in by id, all in one transaction kept out of undo history,
 * so Ctrl+Z never takes back someone else's change:
 *
 * - created elsewhere (or brought back after page mode deleted it): inserted
 *   where the backend has it;
 * - deleted elsewhere: removed, unless it holds text not saved yet, which is
 *   kept under a new id (`keptAsNew` counts them, for a notice) and saved as a
 *   new block;
 * - moved elsewhere: moved with the blocks under it, unless it was moved here
 *   too and the move is not saved yet;
 * - edited elsewhere: its text patched in place, touching only what differs so
 *   a cursor in it stays put, unless it holds an edit not saved yet.
 *
 * Where both sides changed a block, the local change wins at the next save:
 * block mode's last-write-wins rule (#2459). `adoptPatch` then records the
 * backend's tree and every block the patch brought in as saved. A patch that
 * moved or removed blocks ends the undo history there (`forgetHistory`).
 */

import { Fragment, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

import { computeContentDelta } from '@/editor/content-delta'
import { parse } from '@/editor/markdown-serializer'
import {
  blockDocJson,
  depthOf,
  PAGE_BLOCK,
  REMOTE_PATCH,
  restoreSelection,
  selectionEnds,
  startOf,
} from '@/editor/page-mode/page-document'
import {
  longestIncreasing,
  type PageSaveState,
  type SavedBlock,
  type TreeRow,
  treeFromRows,
} from '@/editor/page-mode/page-save'
import { blockIdOf } from '@/editor/token-ids'

export interface RemotePatch {
  tr: Transaction
  /** The backend's rows the patch was made from. */
  rows: readonly TreeRow[]
  /** The text each block the patch wrote now holds, by id. */
  written: Map<string, string>
  /** Blocks deleted elsewhere: none is page mode's to save any more. */
  dropped: string[]
  /** Blocks deleted elsewhere while holding unsaved text, kept under new ids. */
  keptAsNew: number
  /** Whether it moved or removed a block, past which no undo may be rebased. */
  reshaped: boolean
}

function contentOf(schema: Schema, markdown: string): Fragment {
  return Fragment.fromJSON(schema, parse(markdown).content as unknown as Record<string, unknown>[])
}

/** Replace the content of the block at `pos` in `tr` with `content`, touching only what differs. */
function replaceContent(tr: Transaction, pos: number, content: Fragment): void {
  const block = tr.doc.nodeAt(pos) as PMNode
  const start = block.content.findDiffStart(content)
  const end = block.content.findDiffEnd(content)
  if (start === null || end === null) return
  let { a: endA, b: endB } = end
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  const holder = block.type.create(block.attrs, content)
  tr.replace(pos + 1 + start, pos + 1 + endA, holder.slice(start, endB))
  // A range that does not cut cleanly is fitted differently; the whole content always fits.
  const now = tr.doc.nodeAt(pos) as PMNode
  if (!now.content.eq(content)) tr.replaceWith(pos + 1, pos + 1 + now.content.size, content)
}

/**
 * Whether `node` holds what it held when last saved. Not node identity alone:
 * a move or a split at its start makes a new node with the same text, which
 * the save then has nothing to write for, so a peer's text must still show.
 * A block saved with no node yet (read back, never compared) is compared by
 * its markdown, as the save compares it.
 */
function untouched(saved: SavedBlock | undefined, node: PMNode): boolean {
  if (saved === undefined) return false
  if (saved.node === null) return !computeContentDelta(saved.markdown, blockDocJson(node)).changed
  return saved.node === node || saved.node.content.eq(node.content)
}

/** A page's tree: each block's parent, and each parent's children in order. */
interface Tree {
  parentOf: ReadonlyMap<string, string>
  children: ReadonlyMap<string, readonly string[]>
}

/** The tree `doc`'s depths give, under `pageId`. */
function docTree(doc: PMNode, pageId: string): Tree {
  const parentOf = new Map<string, string>()
  const children = new Map<string, string[]>()
  const atDepth: string[] = []
  doc.forEach((node) => {
    const id = blockIdOf(node) as string
    const depth = depthOf(node)
    const parent = depth === 0 ? pageId : (atDepth[depth - 1] ?? pageId)
    parentOf.set(id, parent)
    children.set(parent, [...(children.get(parent) ?? []), id])
    atDepth[depth] = id
  })
  return { parentOf, children }
}

/**
 * The blocks of `among` that `tree` has somewhere other than `base`: under
 * another parent, or out of the longest run of siblings still in `base`'s
 * order, the fewest moves that explain the change (as `planMoves` plans).
 */
function movedFrom(base: Tree, tree: Tree, among: ReadonlySet<string>): Set<string> {
  const moved = new Set<string>()
  for (const [parent, children] of tree.children) {
    const kids = children.filter((id) => among.has(id))
    const before = (base.children.get(parent) ?? []).filter((id) => among.has(id))
    const at = new Map(before.map((id, i) => [id, i]))
    const stayed = kids.filter((id) => at.has(id))
    const run = longestIncreasing(stayed.map((id) => at.get(id) as number))
    stayed.forEach((id, i) => {
      if (!run.has(i)) moved.add(id)
    })
    for (const id of kids) if (!at.has(id)) moved.add(id)
  }
  return moved
}

/** The index and start of the block holding `id` in `doc`, or null. */
function find(doc: PMNode, id: string): { index: number; pos: number } | null {
  let found: { index: number; pos: number } | null = null
  doc.forEach((node, pos, index) => {
    if (found === null && blockIdOf(node) === id) found = { index, pos }
  })
  return found
}

/** The index past the last block under the block at `index`. */
function subtreeEnd(doc: PMNode, index: number): number {
  const depth = depthOf(doc.child(index))
  let end = index + 1
  while (end < doc.childCount && depthOf(doc.child(end)) > depth) end += 1
  return end
}

/**
 * Where block `id` goes in `doc` to sit as `fresh` has it: after the blocks of
 * the nearest sibling before it the document shows, else first under its
 * parent. A parent deleted here and not saved yet is not shown: the block takes
 * that parent's place, so the save that deletes the parent moves it out first.
 */
function target(
  doc: PMNode,
  fresh: Tree,
  id: string,
  pageId: string,
): { index: number; depth: number } {
  const parent = fresh.parentOf.get(id) ?? pageId
  const siblings = fresh.children.get(parent) ?? []
  for (let k = siblings.indexOf(id) - 1; k >= 0; k -= 1) {
    const sibling = find(doc, siblings[k] as string)
    if (sibling !== null) {
      return { index: subtreeEnd(doc, sibling.index), depth: depthOf(doc.child(sibling.index)) }
    }
  }
  if (parent === pageId) return { index: 0, depth: 0 }
  const above = find(doc, parent)
  if (above === null) return target(doc, fresh, parent, pageId)
  return { index: above.index + 1, depth: depthOf(doc.child(above.index)) + 1 }
}

/** The block `id` and the blocks under it, moved in `tr` to where `fresh` has them. */
function moveBlock(tr: Transaction, fresh: Tree, id: string, pageId: string): void {
  const at = find(tr.doc, id)
  if (at === null) return
  const end = subtreeEnd(tr.doc, at.index)
  const nodes: PMNode[] = []
  for (let i = at.index; i < end; i += 1) nodes.push(tr.doc.child(i))
  tr.delete(at.pos, startOf(tr.doc, end))
  const to = target(tr.doc, fresh, id, pageId)
  const shift = to.depth - depthOf(nodes[0] as PMNode)
  const moved = nodes.map((node) =>
    node.type.create({ ...node.attrs, depth: depthOf(node) + shift }, node.content),
  )
  tr.insert(startOf(tr.doc, to.index), moved)
}

/** `rows` as a tree, and their content by id. */
function freshTree(rows: readonly TreeRow[], pageId: string) {
  const parentOf = new Map<string, string>()
  const children = new Map<string, string[]>()
  const content = new Map<string, string>()
  for (const row of rows) {
    const parent = row.parent_id ?? pageId
    parentOf.set(row.id, parent)
    children.set(parent, [...(children.get(parent) ?? []), row.id])
    content.set(row.id, row.content ?? '')
  }
  return { tree: { parentOf, children }, content }
}

/** Remove the blocks deleted elsewhere from `tr`, or rekey the ones holding unsaved text. */
function dropDeleted(
  tr: Transaction,
  save: PageSaveState,
  freshIds: ReadonlySet<string>,
  mintId: () => string,
): { dropped: string[]; keptAsNew: number; removed: number } {
  const dropped = [...save.tree.parentOf.keys()].filter((id) => !freshIds.has(id))
  let keptAsNew = 0
  let removed = 0
  for (const id of dropped) {
    const at = find(tr.doc, id)
    if (at === null) continue
    const node = tr.doc.child(at.index)
    if (untouched(save.saved.get(id), node)) {
      tr.delete(at.pos, at.pos + node.nodeSize)
      removed += 1
    } else {
      tr.setNodeAttribute(at.pos, 'blockId', mintId())
      keptAsNew += 1
    }
  }
  return { dropped, keptAsNew, removed }
}

/**
 * A block whose create or restore the backend refused, and which it does not
 * hold live: its id is one the backend keeps for a block deleted elsewhere
 * (a copy pasted after a peer deleted the original), so the block is saved
 * under a new id rather than refused again on every save. So is every block
 * still to be created, which would be refused the same way, one save each.
 */
function rekeyRefused(
  tr: Transaction,
  save: PageSaveState,
  live: ReadonlyMap<string, string>,
  refused: ReadonlySet<string>,
  mintId: () => string,
): void {
  if (refused.size === 0) return
  tr.doc.forEach((node, pos) => {
    const id = blockIdOf(node) as string
    const unsent = !save.saved.has(id) && !save.deletedAt.has(id)
    if (live.has(id) || !(refused.has(id) || unsent)) return
    tr.setNodeAttribute(pos, 'blockId', mintId())
    save.deletedAt.delete(id)
  })
}

/**
 * The blocks `fresh` has somewhere other than `save` last knew, which the
 * document still has where `save` knew them: moved elsewhere, not here. Only
 * blocks all three hold count, so a block created or deleted beside one does
 * not move it.
 */
function movedElsewhere(doc: PMNode, save: PageSaveState, fresh: Tree): Set<string> {
  const local = docTree(doc, save.pageId)
  const common = new Set(
    [...fresh.parentOf.keys()].filter((id) => save.tree.parentOf.has(id) && local.parentOf.has(id)),
  )
  const here = movedFrom(save.tree, local, common)
  return new Set([...movedFrom(save.tree, fresh, common)].filter((id) => !here.has(id)))
}

/** Patch in the text of each block edited elsewhere and untouched here. */
function patchTexts(
  tr: Transaction,
  save: PageSaveState,
  content: ReadonlyMap<string, string>,
  written: Map<string, string>,
): void {
  const from = tr.steps.length
  tr.doc.forEach((node, offset) => {
    const id = blockIdOf(node) as string
    const saved = save.saved.get(id)
    const markdown = content.get(id)
    if (saved === undefined || markdown === undefined || written.has(id)) return
    if (markdown === saved.markdown || !untouched(saved, node)) return
    const pos = tr.mapping.slice(from).map(offset)
    replaceContent(tr, pos, contentOf(tr.doc.type.schema, markdown))
    written.set(id, markdown)
  })
}

/**
 * The transaction that brings `rows`, the page as the backend now holds it,
 * into `state`'s document against `save`. Its `tr` may change nothing; either
 * way, `adoptPatch` follows it.
 */
export function remotePatch(
  state: EditorState,
  save: PageSaveState,
  rows: readonly TreeRow[],
  mintId: () => string,
  refused: ReadonlySet<string> = new Set(),
): RemotePatch {
  const { pageId } = save
  const fresh = freshTree(rows, pageId)
  const tr = state.tr
  const ends = selectionEnds(state.doc, state.selection)
  // Judged on the document as the user left it: a parent removed or rekeyed
  // below would otherwise read as a move made here of the blocks under it.
  const moved = movedElsewhere(state.doc, save, fresh.tree)
  const { dropped, keptAsNew, removed } = dropDeleted(
    tr,
    save,
    new Set(fresh.content.keys()),
    mintId,
  )
  rekeyRefused(tr, save, fresh.content, refused, mintId)
  const shown = new Set<string>()
  tr.doc.forEach((node) => shown.add(blockIdOf(node) as string))
  const type = state.schema.nodes[PAGE_BLOCK] as NodeType
  const written = new Map<string, string>()
  // In the backend's order, so a block's parent and the siblings before it are in place.
  for (const [id, markdown] of fresh.content) {
    if (moved.has(id)) {
      moveBlock(tr, fresh.tree, id, pageId)
      continue
    }
    if (save.tree.parentOf.has(id) || shown.has(id)) continue
    const to = target(tr.doc, fresh.tree, id, pageId)
    const node = type.create({ blockId: id, depth: to.depth }, contentOf(state.schema, markdown))
    tr.insert(startOf(tr.doc, to.index), node)
    shown.add(id)
    written.set(id, markdown)
  }
  if (tr.docChanged) restoreSelection(tr, ends)
  patchTexts(tr, save, fresh.content, written)
  tr.setMeta('addToHistory', false).setMeta(REMOTE_PATCH, true)
  return { tr, rows, written, dropped, keptAsNew, reshaped: removed > 0 || moved.size > 0 }
}

/**
 * Record what `patch` brought in, once `doc` holds it: the backend's tree,
 * each block it wrote as saved at that text, a block brought back after page
 * mode deleted it as no longer deleted, and a block deleted elsewhere as gone.
 */
export function adoptPatch(doc: PMNode, save: PageSaveState, patch: RemotePatch): void {
  save.tree = treeFromRows(save.pageId, patch.rows)
  for (const id of patch.dropped) save.saved.delete(id)
  for (const row of patch.rows) {
    save.deletedAt.delete(row.id)
    if (!save.saved.has(row.id)) save.saved.set(row.id, { node: null, markdown: row.content ?? '' })
  }
  doc.forEach((node) => {
    const id = blockIdOf(node) as string
    const markdown = patch.written.get(id)
    if (markdown !== undefined) save.saved.set(id, { node, markdown })
  })
}

/** Bring `rows` into `view`'s document and `save` (`remotePatch`, then `adoptPatch`). */
export function applyRemote(
  view: EditorView,
  save: PageSaveState,
  rows: readonly TreeRow[],
  mintId: () => string,
  refused?: ReadonlySet<string>,
): { keptAsNew: number } {
  const patch = remotePatch(view.state, save, rows, mintId, refused)
  if (patch.tr.docChanged) view.dispatch(patch.tr)
  if (patch.reshaped) forgetHistory(view)
  adoptPatch(view.state.doc, save, patch)
  return { keptAsNew: patch.keptAsNew }
}

/**
 * Drop the undo history, as block mode drops a page's undo anchors when a
 * sync changes it (#731): an undo rebased past a block moved or removed
 * elsewhere would put back a copy of it.
 */
function forgetHistory(view: EditorView): void {
  const { doc, selection, plugins } = view.state
  view.updateState(EditorState.create({ doc, selection, plugins }))
}
