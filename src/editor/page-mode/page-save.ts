/**
 * Page mode's continuous save (#5691, option B). Each save walks the document
 * once and compares every block with its own last-saved state: a node that is
 * the same object as the one last saved is unchanged and skipped; any other
 * goes through `computeContentDelta`, so a block the serialiser only
 * canonicalises writes nothing (#711). Writes go through the block commands in
 * `apply_page_source`'s order: creates (under the client's ids) and restores,
 * then moves, then edits, then deletes. A create comes before the edit that
 * shortens the block it split from (#5272), and a move takes a block out from
 * under one about to be deleted before the delete cascades.
 *
 * A block's saved state advances only when its write succeeds, so a failed
 * write is tried again by the next save, and it holds back only the writes
 * that need it. A block whose create or restore failed holds back the blocks
 * under it (their creates and moves) and an edit taking text out of the block
 * before it, which may be the half split off. A failed move stops the moves
 * after it, whose slots assumed it. A delete waits while a block under it
 * (itself included) is one the document shows, or has its text in a block the
 * backend does not hold as the document shows it (joined or pasted there), for
 * the delete takes the blocks under it along. Each would otherwise leave text
 * only in the document.
 *
 * A block the document brings back after page mode deleted it (an undo) is
 * restored by id with `restore_block`, never created again, so references to
 * it keep working. A restore can bring back more than the block (its deleted
 * descendants and ancestors), so the save then rereads the page's tree. A new
 * block is created only once it holds something, or holds a block that does,
 * or is about to take a task state (`keep`).
 *
 * `tree` mirrors the backend's tree of the page as far as page mode knows it,
 * for the sibling index each create and move takes. It also holds blocks the
 * document does not show (a peer's new block, read by a reread). Page mode
 * deletes only blocks it saved, but a delete takes the block's descendants
 * with it, so one of those goes when page mode deletes its parent.
 */

import type { Node as PMNode } from '@tiptap/pm/model'

import { computeContentDelta } from '@/editor/content-delta'
import { notifyUnknownNodeTypeToast } from '@/editor/markdown-serialize-toast'
import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson, depthOf } from '@/editor/page-mode/page-document'
import { blockIdOf } from '@/editor/token-ids'
import type { OpRef } from '@/lib/bindings'

export interface SavedBlock {
  /** The node last written or read; `null` until a restored block is next compared. */
  node: PMNode | null
  markdown: string
}

export interface PageTree {
  /** Child ids in sibling order, by parent id; the page's own id for the top level. */
  children: Map<string, string[]>
  parentOf: Map<string, string>
}

export interface PageSaveState {
  pageId: string
  saved: Map<string, SavedBlock>
  tree: PageTree
  /** The `deleted_at` of each block page mode deleted, which `restore_block` asks for. */
  deletedAt: Map<string, number>
  /** How many writes reached the backend: a read made while this moved may predate one. */
  writes: number
  /** New blocks to create although empty: one about to take a task state. */
  keep: Set<string>
}

/** One live block of the page, as the backend lists it: parents before children, siblings in order. */
export interface TreeRow {
  id: string
  parent_id: string | null
  content: string | null
}

export interface PageSaveApi {
  create: (id: string, parentId: string, index: number, markdown: string) => Promise<OpRef[]>
  restore: (id: string, deletedAt: number) => Promise<void>
  move: (id: string, parentId: string, index: number) => Promise<OpRef[]>
  edit: (id: string, markdown: string) => Promise<OpRef[]>
  remove: (id: string) => Promise<{ deletedAt: number; refs: OpRef[] }>
  /** The page's live blocks, read again after a restore. */
  tree: () => Promise<TreeRow[]>
}

export type SaveOp =
  | { kind: 'create'; id: string; parentId: string; index: number; markdown: string; node: PMNode }
  | { kind: 'restore'; id: string; deletedAt: number }
  | { kind: 'move'; id: string; parentId: string; index: number }
  | { kind: 'edit'; id: string; markdown: string; node: PMNode }
  | { kind: 'settle'; id: string; node: PMNode }
  | { kind: 'delete'; id: string }

export interface SaveResult {
  /** The refs of every op this save appended, in order. */
  refs: OpRef[]
  /** Whether it created, restored, moved or deleted a block, not only edited text. */
  structural: boolean
  /** The blocks whose text it wrote. */
  edited: Set<string>
  /** The first write that failed; its block keeps its saved state for the next save. */
  error: unknown
  /** The op of that write. */
  failed: SaveOp | null
}

export function treeFromRows(pageId: string, rows: readonly TreeRow[]): PageTree {
  const tree: PageTree = { children: new Map(), parentOf: new Map() }
  for (const row of rows) insertChild(tree, row.parent_id ?? pageId, row.id, Infinity)
  return tree
}

/** The save state of a document just opened from `rows`, the page as the store holds it. */
export function createSaveState(
  pageId: string,
  rows: readonly TreeRow[],
  doc: PMNode,
): PageSaveState {
  const content = new Map(rows.map((row) => [row.id, row.content ?? '']))
  const saved = new Map<string, SavedBlock>()
  doc.forEach((node) => {
    const id = blockIdOf(node)
    const markdown = id === null ? undefined : content.get(id)
    if (id !== null && markdown !== undefined) saved.set(id, { node, markdown })
  })
  return {
    pageId,
    saved,
    tree: treeFromRows(pageId, rows),
    deletedAt: new Map(),
    writes: 0,
    keep: new Set(),
  }
}

// ── The tree mirror ───────────────────────────────────────────────────────

function childrenOf(tree: PageTree, parentId: string): string[] {
  let children = tree.children.get(parentId)
  if (children === undefined) {
    children = []
    tree.children.set(parentId, children)
  }
  return children
}

function insertChild(tree: PageTree, parentId: string, id: string, index: number): void {
  const children = childrenOf(tree, parentId)
  children.splice(Math.min(index, children.length), 0, id)
  tree.parentOf.set(id, parentId)
}

function detach(tree: PageTree, id: string): void {
  const parentId = tree.parentOf.get(id)
  if (parentId === undefined) return
  const children = childrenOf(tree, parentId)
  const at = children.indexOf(id)
  if (at !== -1) children.splice(at, 1)
}

/** `id` and every block under it, parents first. */
function subtreeOf(tree: PageTree, id: string): string[] {
  const out = [id]
  for (const member of out) out.push(...(tree.children.get(member) ?? []))
  return out
}

function cloneTree(tree: PageTree): PageTree {
  return {
    children: new Map([...tree.children].map(([id, children]) => [id, [...children]])),
    parentOf: new Map(tree.parentOf),
  }
}

/** The slot right after `anchor` among `parentId`'s children other than `id`; 0 with no anchor. */
function slotAfter(tree: PageTree, parentId: string, id: string, anchor: string | null): number {
  if (anchor === null) return 0
  const others = childrenOf(tree, parentId).filter((child) => child !== id)
  return others.indexOf(anchor) + 1
}

/** Positions in `sequence` of a longest strictly increasing run of its values. */
export function longestIncreasing(sequence: readonly number[]): Set<number> {
  const tails: number[] = []
  const previous: number[] = []
  sequence.forEach((value, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((sequence[tails[mid] as number] as number) < value) lo = mid + 1
      else hi = mid
    }
    previous[i] = lo > 0 ? (tails[lo - 1] as number) : -1
    tails[lo] = i
  })
  const kept = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i !== -1; i = previous[i] as number) kept.add(i)
  return kept
}

// ── Planning ──────────────────────────────────────────────────────────────

interface DesiredBlock {
  id: string
  node: PMNode
  parentId: string
}

/**
 * The blocks the backend should hold, in document order, under the parents
 * their depths give them: every block it knows, and each new block that holds
 * something, holds a block that does, or is to be kept.
 */
export function desiredBlocks(doc: PMNode, state: PageSaveState): DesiredBlock[] {
  const all: DesiredBlock[] = []
  const atDepth: string[] = []
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id === null) return
    const depth = depthOf(node)
    all.push({ id, node, parentId: depth === 0 ? state.pageId : (atDepth[depth - 1] as string) })
    atDepth[depth] = id
    atDepth.length = depth + 1
  })
  const holdsKept = new Set<string>()
  const kept: DesiredBlock[] = []
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const block = all[i] as DesiredBlock
    const known = state.saved.has(block.id) || state.deletedAt.has(block.id)
    const wanted = holdsKept.has(block.id) || state.keep.has(block.id)
    if (known || wanted || markdownOf(block.node) !== '') {
      holdsKept.add(block.parentId)
      kept.push(block)
    }
  }
  return kept.toReversed()
}

function markdownOf(node: PMNode): string {
  return serialize(blockDocJson(node), notifyUnknownNodeTypeToast)
}

/** The slot a new block takes: after the nearest block before it, among its siblings, already there. */
function createSlot(tree: PageTree, desired: readonly DesiredBlock[], i: number): number {
  const { parentId, id } = desired[i] as DesiredBlock
  const present = new Set(childrenOf(tree, parentId))
  for (let j = i - 1; j >= 0; j -= 1) {
    const sibling = desired[j] as DesiredBlock
    if (sibling.parentId === parentId && present.has(sibling.id)) {
      return slotAfter(tree, parentId, id, sibling.id)
    }
  }
  return 0
}

/**
 * Creates and restores, parents first, but none of `held` (failed this save)
 * nor under one. Plans against a copy of the tree.
 */
export function planCreates(
  desired: readonly DesiredBlock[],
  state: PageSaveState,
  held: ReadonlySet<string> = new Set(),
): SaveOp[] {
  const tree = cloneTree(state.tree)
  const ops: SaveOp[] = []
  const waiting = new Set(held)
  desired.forEach((block, i) => {
    if (state.saved.has(block.id)) return
    if (waiting.has(block.id) || waiting.has(block.parentId)) {
      waiting.add(block.id)
      return
    }
    const deletedAt = state.deletedAt.get(block.id)
    if (deletedAt !== undefined) {
      ops.push({ kind: 'restore', id: block.id, deletedAt })
      return
    }
    const op: SaveOp = {
      kind: 'create',
      id: block.id,
      parentId: block.parentId,
      index: createSlot(tree, desired, i),
      markdown: markdownOf(block.node),
      node: block.node,
    }
    applyToTree(tree, op)
    ops.push(op)
  })
  return ops
}

/**
 * The fewest moves that give each parent its children in document order: the
 * children already in order (a longest increasing run) stay, the rest move in
 * after the child before them. Parents are visited top-down, so a block never
 * moves under one of its own descendants. A block the backend does not hold
 * (its create failed or waits) neither moves nor takes children; a block under
 * it stays where it is, and so does a block whose new parent is still under it.
 */
export function planMoves(desired: readonly DesiredBlock[], state: PageSaveState): SaveOp[] {
  const tree = cloneTree(state.tree)
  const absent = (id: string): boolean => id !== state.pageId && !tree.parentOf.has(id)
  const wanted = new Map<string, string[]>()
  for (const block of desired) {
    const children = wanted.get(block.parentId) ?? []
    children.push(block.id)
    wanted.set(block.parentId, children)
  }
  const ops: SaveOp[] = []
  for (const parentId of [state.pageId, ...desired.map((block) => block.id)]) {
    const children = wanted.get(parentId)
    if (children === undefined || absent(parentId)) continue
    const current = childrenOf(tree, parentId)
    const at = new Map(current.map((id, i) => [id, i]))
    const inPlace = children.filter((id) => at.has(id))
    const stay = longestIncreasing(inPlace.map((id) => at.get(id) as number))
    const staying = new Set([...stay].map((i) => inPlace[i] as string))
    let anchor: string | null = null
    for (const id of children) {
      if (!staying.has(id)) {
        if (absent(id) || subtreeOf(tree, id).includes(parentId)) continue
        const op: SaveOp = {
          kind: 'move',
          id,
          parentId,
          index: slotAfter(tree, parentId, id, anchor),
        }
        applyToTree(tree, op)
        ops.push(op)
      }
      anchor = id
    }
  }
  return ops
}

/** A block's text as a join carries it, an inline atom (a chip, an image) as one character. */
function textOf(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', '\uFFFC')
}

/** Whether `after` lost text `before` held: anything between their common start and end. */
function losesText(before: PMNode | null, after: PMNode): boolean {
  if (before === null) return false
  const [was, now] = [textOf(before), textOf(after)]
  const shorter = Math.min(was.length, now.length)
  let start = 0
  while (start < shorter && was[start] === now[start]) start += 1
  let end = 0
  while (end < shorter - start && was.at(-1 - end) === now.at(-1 - end)) end += 1
  return start + end < was.length
}

/**
 * The block before each block still to be created, whatever its depth (a new
 * half is outdented after the split): the one it may be split from. Only the
 * block right before it, so a paste in the middle of a block, which hands the
 * block's tail to the last block pasted, is held only while the blocks pasted
 * before that one are not saved either.
 */
function splitSources(desired: readonly DesiredBlock[], state: PageSaveState): Set<string> {
  const sources = new Set<string>()
  desired.forEach((block, i) => {
    const source = desired[i - 1]
    if (source !== undefined && !state.saved.has(block.id)) sources.add(source.id)
  })
  return sources
}

/**
 * An edit for each block whose text changed since its last save, but none
 * taking text out of a block that one still to be created follows (its create
 * failed or waits): that text may be the half split off it. A settle for a
 * block that did not change.
 */
export function planEdits(desired: readonly DesiredBlock[], state: PageSaveState): SaveOp[] {
  const sources = splitSources(desired, state)
  const ops: SaveOp[] = []
  for (const { id, node } of desired) {
    const saved = state.saved.get(id)
    if (saved === undefined || saved.node === node) continue
    const delta = computeContentDelta(saved.markdown, blockDocJson(node))
    if (!delta.changed) ops.push({ kind: 'settle', id, node })
    else if (!sources.has(id) || !losesText(saved.node, node)) {
      ops.push({ kind: 'edit', id, markdown: delta.newMarkdown, node })
    }
  }
  return ops
}

/**
 * A delete for each saved block gone from the document, but none under
 * another one going, and none with a block under it (itself included) that
 * the document still shows (its move out failed or waits), or whose text a
 * block the backend does not hold as the document shows it holds (joined or
 * pasted into a block whose create or edit failed): the delete takes the
 * blocks under it along.
 */
export function planDeletes(desired: readonly DesiredBlock[], state: PageSaveState): SaveOp[] {
  const shown = new Set(desired.map((block) => block.id))
  const unwritten = desired
    .filter((block) => state.saved.get(block.id)?.node !== block.node)
    .map((block) => textOf(block.node))
  const carried = (id: string): boolean => {
    const node = state.saved.get(id)?.node ?? null
    const text = node === null ? '' : textOf(node)
    return text !== '' && unwritten.some((holder) => holder.includes(text))
  }
  const going = new Set(
    [...state.saved.keys()].filter(
      (id) =>
        !shown.has(id) &&
        !subtreeOf(state.tree, id).some((member) => shown.has(member) || carried(member)),
    ),
  )
  return [...going]
    .filter((id) => !going.has(state.tree.parentOf.get(id) as string))
    .map((id) => ({ kind: 'delete', id }))
}

function applyToTree(tree: PageTree, op: Extract<SaveOp, { kind: 'create' | 'move' }>): void {
  detach(tree, op.id)
  insertChild(tree, op.parentId, op.id, op.index)
}

// ── Running a save ────────────────────────────────────────────────────────

/** Run `op`, and only once it succeeded, advance the save state to it. */
async function run(op: SaveOp, state: PageSaveState, api: PageSaveApi): Promise<OpRef[]> {
  switch (op.kind) {
    case 'create': {
      const refs = await api.create(op.id, op.parentId, op.index, op.markdown)
      applyToTree(state.tree, op)
      state.saved.set(op.id, { node: op.node, markdown: op.markdown })
      return refs
    }
    case 'restore': {
      await api.restore(op.id, op.deletedAt)
      await reread(state, api, op.id)
      return []
    }
    case 'move': {
      const refs = await api.move(op.id, op.parentId, op.index)
      applyToTree(state.tree, op)
      return refs
    }
    case 'edit': {
      const refs = await api.edit(op.id, op.markdown)
      state.saved.set(op.id, { node: op.node, markdown: op.markdown })
      return refs
    }
    case 'settle': {
      ;(state.saved.get(op.id) as SavedBlock).node = op.node
      return []
    }
    case 'delete': {
      const { deletedAt, refs } = await api.remove(op.id)
      const members = subtreeOf(state.tree, op.id)
      detach(state.tree, op.id)
      for (const id of members) {
        state.saved.delete(id)
        state.deletedAt.set(id, deletedAt)
        state.tree.parentOf.delete(id)
        state.tree.children.delete(id)
      }
      return refs
    }
  }
}

/**
 * Take the tree the backend now holds after restoring `restored`, and every
 * block that restore brought back as saved: the ones page mode deleted, and
 * any ancestor it did not know (deleted elsewhere), which the save then
 * deletes again unless the document shows it.
 */
async function reread(state: PageSaveState, api: PageSaveApi, restored: string): Promise<void> {
  const known = state.tree.parentOf
  const rows = await api.tree()
  state.tree = treeFromRows(state.pageId, rows)
  const content = new Map(rows.map((row) => [row.id, row.content ?? '']))
  for (const row of rows) {
    if (!state.deletedAt.delete(row.id)) continue
    state.saved.set(row.id, { node: null, markdown: row.content ?? '' })
  }
  const { parentOf } = state.tree
  for (let up = parentOf.get(restored); up !== undefined; up = parentOf.get(up)) {
    if (!known.has(up) && !state.saved.has(up) && content.has(up)) {
      state.saved.set(up, { node: null, markdown: content.get(up) as string })
    }
  }
}

/** Run `ops` in order, or until one fails with `stopOnFailure`; resolves the first that failed. */
async function runAll(
  ops: readonly SaveOp[],
  state: PageSaveState,
  api: PageSaveApi,
  result: SaveResult,
  { stopOnFailure }: { stopOnFailure: boolean },
): Promise<SaveOp | null> {
  let failed: SaveOp | null = null
  for (const op of ops) {
    try {
      result.refs.push(...(await run(op, state, api)))
      if (op.kind !== 'settle') state.writes += 1
      if (op.kind === 'edit') result.edited.add(op.id)
      else if (op.kind !== 'settle') result.structural = true
    } catch (err) {
      failed ??= op
      if (result.failed === null) {
        result.error = err
        result.failed = op
      }
      if (stopOnFailure) break
    }
  }
  return failed
}

/** Save what changed in `doc` since `state` last saved it, adding to `result` when given. */
export async function savePage(
  doc: PMNode,
  state: PageSaveState,
  api: PageSaveApi,
  result: SaveResult = {
    refs: [],
    structural: false,
    edited: new Set(),
    error: undefined,
    failed: null,
  },
): Promise<SaveResult> {
  // The blocks whose create or restore failed: the ones under them wait (`planCreates`).
  const held = new Set<string>()
  // A restore rereads the tree, which can make other blocks saved; plan again after one, and
  // after a failure, so the creates after it take their slots from the tree as it is.
  const restored = new Set<string>()
  for (;;) {
    const creates = planCreates(desiredBlocks(doc, state), state, held)
    const restoreAt = creates.findIndex((op) => op.kind === 'restore')
    const restoring = creates[restoreAt]?.id
    if (restoring !== undefined && restored.has(restoring)) {
      result.error ??= new Error(`restoring block ${restoring} did not bring it back to the page`)
      held.add(restoring)
      continue
    }
    const batch = restoring === undefined ? creates : creates.slice(0, restoreAt + 1)
    const failed = await runAll(batch, state, api, result, { stopOnFailure: true })
    if (failed !== null) held.add(failed.id)
    else if (restoring === undefined) break
    else restored.add(restoring)
  }
  const desired = desiredBlocks(doc, state)
  await runAll(planMoves(desired, state), state, api, result, { stopOnFailure: true })
  await runAll(planEdits(desired, state), state, api, result, { stopOnFailure: false })
  await runAll(planDeletes(desired, state), state, api, result, { stopOnFailure: false })
  return result
}
