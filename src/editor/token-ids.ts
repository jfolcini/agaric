/**
 * Block ids that follow text (#5160 phase 5, #5691): the rules the *Edit as
 * Markdown* buffer (`source-buffer.ts`, one block per `line`) and page mode
 * (`page-mode/page-block-ids.ts`, one per `pageBlock`) share. A block's id
 * belongs to its first token, a character or, empty, its end, and follows it
 * through every edit. So Enter keeps the id where the text it splits starts,
 * a join keeps the first block's id and drops the second's, and a block whose
 * first token no edit moved keeps the id it holds, unless another block
 * already does. A cut or a drag takes the id of each block whose first token
 * and last are both gone, so the block left where it was gets none, and
 * pasting that text where a block starts moves the block. Each surface says
 * where its blocks' tokens sit (`Tokens`).
 */

import type { Node as PMNode, ResolvedPos, Slice } from '@tiptap/pm/model'
import { Fragment, Slice as PMSlice } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { type Mappable, Mapping } from '@tiptap/pm/transform'

export function blockIdOf(node: PMNode): string | null {
  return (node.attrs['blockId'] as string | null | undefined) ?? null
}

/** Where a top-level block of a surface keeps its first and last tokens: the position before each. */
export interface Tokens {
  first: (node: PMNode, offset: number) => number
  last: (node: PMNode, offset: number) => number
}

/**
 * Whether the token at `pos` is gone after the change `mapping` maps over: the
 * positions either side of it no longer one apart.
 */
export function goneAt(mapping: Mappable, pos: number): boolean {
  return mapping.map(pos + 1, -1) - mapping.map(pos, 1) !== 1
}

/** Whether `transactions` hold a cut or a drag, either of which carries blocks' ids off. */
export function takesIds(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => ['cut', 'drop'].includes(tr.getMeta('uiEvent')))
}

/**
 * The ids a cut or a drag over `mapping` took from the blocks of `before`, by
 * the index in `after` of the block left where each was: the block whose
 * first token and last are both gone. A cut that leaves part of a block leaves
 * the block its id, as deleting it does.
 */
export function takenIds(
  before: PMNode,
  after: PMNode,
  mapping: Mappable,
  tokens: Tokens,
): Map<number, Set<string>> {
  const taken = new Map<number, Set<string>>()
  before.forEach((node, offset) => {
    const id = blockIdOf(node)
    const start = tokens.first(node, offset)
    if (id === null || !goneAt(mapping, start) || !goneAt(mapping, tokens.last(node, offset))) {
      return
    }
    const left = after.resolve(Math.min(mapping.map(start, -1), after.content.size)).index(0)
    taken.set(left, (taken.get(left) ?? new Set()).add(id))
  })
  return taken
}

/**
 * Each top-level block's id after `transactions` turned `before` into `after`:
 * the id of the block whose first token it now starts with, else the id it
 * holds, unless another block holds that id already, or it is the block a cut
 * or a drag took that id from.
 */
export function idsAfter(
  transactions: readonly Transaction[],
  before: PMNode,
  after: PMNode,
  tokens: Tokens,
): Array<string | null> {
  const mapping = new Mapping()
  for (const tr of transactions) mapping.appendMapping(tr.mapping)
  const taken = takesIds(transactions) ? takenIds(before, after, mapping, tokens) : new Map()
  const startsAt = new Map<number, number>()
  after.forEach((node, offset, i) => startsAt.set(tokens.first(node, offset), i))
  const moved = new Map<number, string>()
  before.forEach((node, offset) => {
    const id = blockIdOf(node)
    const start = tokens.first(node, offset)
    if (id === null || goneAt(mapping, start)) return
    const index = startsAt.get(mapping.map(start, 1))
    if (index !== undefined && !moved.has(index)) moved.set(index, id)
  })
  const held = new Set(moved.values())
  const ids: Array<string | null> = []
  after.forEach((node, _offset, i) => {
    const own = moved.get(i)
    const kept = blockIdOf(node)
    if (own !== undefined) {
      ids.push(own)
    } else if (kept !== null && !held.has(kept) && taken.get(i)?.has(kept) !== true) {
      held.add(kept)
      ids.push(kept)
    } else {
      ids.push(null)
    }
  })
  return ids
}

export function holdsId(doc: PMNode, id: string): boolean {
  let held = false
  doc.forEach((node) => {
    held ||= blockIdOf(node) === id
  })
  return held
}

/**
 * `slice` with no id but `pageIds`: a block carrying another page's id is a
 * new block, as a copy is (#5160 D15).
 */
export function withPageIds(slice: Slice, pageIds: ReadonlySet<string | null>): Slice {
  const nodes: PMNode[] = []
  slice.content.forEach((node) => {
    const id = blockIdOf(node)
    nodes.push(
      pageIds.has(id) ? node : node.type.create({ ...node.attrs, blockId: null }, node.content),
    )
  })
  return new PMSlice(Fragment.from(nodes), slice.openStart, slice.openEnd)
}

/**
 * Paste `slice` over `tr`'s selection. Pasted where a block starts
 * (`atStart`), its first block, if it holds anything, starts that block, under
 * its own id when no block holds it: a block cut and pasted there is a move.
 * The id rules leave that id there unless the block's own start stayed first.
 */
export function pasteKeepingIds(tr: Transaction, slice: Slice, atStart: boolean): Transaction {
  const { $from } = tr.selection
  const before = tr.doc
  const steps = tr.steps.length
  tr.replaceSelection(slice)
  const first = slice.openStart > 0 ? slice.content.firstChild : null
  const id = first === null || !holdsContent(first) ? null : blockIdOf(first)
  if (id !== null && atStart && !holdsId(before, id)) {
    const start = tr.mapping.slice(steps).map($from.pos, -1)
    tr.setNodeAttribute(blockStart(tr.doc.resolve(start)), 'blockId', id)
  }
  return tr.scrollIntoView()
}

/** Whether `node` holds a token other than its end: text, a chip, any leaf. */
function holdsContent(node: PMNode): boolean {
  let holds = false
  node.descendants((child) => {
    holds ||= child.isLeaf
    return !holds
  })
  return holds
}

/** The start of the top-level block `$pos` is in. */
function blockStart($pos: ResolvedPos): number {
  return $pos.before(1)
}
