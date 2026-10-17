/**
 * Page mode's id rules (#5691), the source buffer's (`source-buffer.ts`) moved
 * from lines to blocks: a block's id belongs to its first token, a character
 * or, empty, its end, and follows it through every edit. So Enter keeps the id
 * on the block the text it splits starts in, and a join keeps the first block's
 * id and drops the second's. A block whose first token no edit moved keeps the
 * id it has unless another block already holds it, the way TipTap's UniqueID
 * drops a duplicate. A paste brings in no ids, so a pasted block is new.
 *
 * A block left without an id gets a fresh one at once: it exists only in the
 * document until it holds something (`page-save.ts`). Depth is kept a tree:
 * the first block at 0, each other at most one deeper than the block before.
 */

import { Extension } from '@tiptap/core'
import { Fragment, type Node as PMNode, type NodeType, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { type Mappable, Mapping } from '@tiptap/pm/transform'

import { blockIdOf, depthOf, firstTokenPos, PAGE_BLOCK } from '@/editor/page-mode/page-document'
import { newBlockId } from '@/lib/block-id'

export const pageBlockIdsKey = new PluginKey('pageBlockIds')

/**
 * Whether the token at `pos` is gone after the change `mapping` maps over: the
 * positions either side of it no longer one apart.
 */
function goneAt(mapping: Mappable, pos: number): boolean {
  return mapping.map(pos + 1, -1) - mapping.map(pos, 1) !== 1
}

function holdsPageBlock(fragment: Fragment, type: NodeType): boolean {
  let found = false
  fragment.descendants((node) => {
    found ||= node.type === type
    return !found && !node.isTextblock
  })
  return found
}

/**
 * Whether `tr` can change which block holds which id, or a block's depth: a
 * step outside a single block's content, or one that brings blocks in or sets
 * a block's attributes. Typing inside a block cannot, and is the common case.
 */
function changesBlocks(tr: Transaction, type: NodeType): boolean {
  return tr.steps.some((step, i) => {
    const doc = tr.docs[i]
    if (doc === undefined) return true
    // Duck-typed: ProseMirror can be loaded twice, so no `instanceof` (AGENTS.md).
    const { pos, attr, from, to, slice } = step as Partial<{
      pos: number
      attr: string
      from: number
      to: number
      slice: Slice
    }>
    if (attr !== undefined && pos !== undefined) return doc.nodeAt(pos)?.type === type
    if (slice === undefined || from === undefined || to === undefined) return false
    const $from = doc.resolve(from)
    const $to = doc.resolve(to)
    return (
      $from.depth < 1 ||
      $to.depth < 1 ||
      $from.index(0) !== $to.index(0) ||
      holdsPageBlock(slice.content, type)
    )
  })
}

/**
 * Each block's id after `transactions` turned `before` into `after`: the id of
 * the block whose first token it now starts with, else the id it holds, unless
 * another block holds that id already.
 */
export function blockIdsAfter(
  transactions: readonly Transaction[],
  before: PMNode,
  after: PMNode,
): Array<string | null> {
  const mapping = new Mapping()
  for (const tr of transactions) mapping.appendMapping(tr.mapping)
  const startsAt = new Map<number, number>()
  after.forEach((node, offset, i) => startsAt.set(firstTokenPos(node, offset), i))
  const moved = new Map<number, string>()
  before.forEach((node, offset) => {
    const id = blockIdOf(node)
    const start = firstTokenPos(node, offset)
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
    } else if (kept !== null && !held.has(kept)) {
      held.add(kept)
      ids.push(kept)
    } else {
      ids.push(null)
    }
  })
  return ids
}

/** `slice` with every block it brings in under no id. */
function withoutIds(slice: Slice, type: NodeType): Slice {
  if (!holdsPageBlock(slice.content, type)) return slice
  const nodes: PMNode[] = []
  slice.content.forEach((node) => {
    nodes.push(
      node.type === type ? type.create({ ...node.attrs, blockId: null }, node.content) : node,
    )
  })
  return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd)
}

interface PageBlockIdsOptions {
  /** Mints a new block's id; a test passes a deterministic one. */
  mintId: () => string
}

export const PageBlockIds = Extension.create<PageBlockIdsOptions>({
  name: 'pageBlockIds',
  addOptions() {
    return { mintId: newBlockId }
  },
  addProseMirrorPlugins() {
    const { mintId } = this.options
    const type = this.editor.schema.nodes[PAGE_BLOCK] as NodeType
    return [
      new Plugin({
        key: pageBlockIdsKey,
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged && changesBlocks(tr, type))) return null
          const ids = blockIdsAfter(transactions, oldState.doc, newState.doc)
          const tr = newState.tr
          let previousDepth = -1
          newState.doc.forEach((node, offset, i) => {
            const id = ids[i] ?? mintId()
            if (blockIdOf(node) !== id) tr.setNodeAttribute(offset, 'blockId', id)
            const depth = Math.max(0, Math.min(depthOf(node), previousDepth + 1))
            if (depthOf(node) !== depth) tr.setNodeAttribute(offset, 'depth', depth)
            previousDepth = depth
          })
          return tr.docChanged ? tr : null
        },
        props: {
          transformPasted: (slice) => withoutIds(slice, type),
        },
      }),
    ]
  },
})
