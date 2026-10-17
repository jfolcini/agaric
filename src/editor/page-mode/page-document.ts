/**
 * Page mode's document (#5691): one ProseMirror document for the whole page, a
 * flat run of `pageBlock(blockId, depth)` nodes. Each holds what one block holds
 * in block mode, under the same content nodes, so a block's markdown is its
 * node's content serialised as a block-mode document. Depth stands in for the
 * tree: a block's parent is the nearest block before it one level up, as in the
 * page store's `FlatBlock[]`.
 */

import { type JSONContent, Node } from '@tiptap/core'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { type Selection, TextSelection, type Transaction } from '@tiptap/pm/state'

import { parse } from '@/editor/markdown-serializer'
import { blockIdOf } from '@/editor/token-ids'
import type { DocNode } from '@/editor/types'

export const PAGE_BLOCK = 'pageBlock'

export const PageDocument = Node.create({ name: 'doc', topNode: true, content: `${PAGE_BLOCK}+` })

export const PageBlock = Node.create({
  name: PAGE_BLOCK,
  content: 'block+',
  addAttributes() {
    return {
      blockId: {
        default: null,
        // The id rules (`page-block-ids.ts`) decide which half of a split keeps it.
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute('data-page-block-id'),
        renderHTML: (attributes) =>
          attributes['blockId'] == null ? {} : { 'data-page-block-id': attributes['blockId'] },
      },
      depth: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-depth') ?? 0) || 0,
        renderHTML: (attributes) => {
          const depth = Number(attributes['depth'])
          return depth > 0
            ? {
                'data-depth': String(depth),
                style: `margin-left: calc(var(--indent-width) * ${depth})`,
              }
            : { 'data-depth': '0' }
        },
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-page-block]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-page-block': '', ...HTMLAttributes }, 0]
  },
})

export function depthOf(node: PMNode): number {
  return Number(node.attrs['depth'] ?? 0)
}

/**
 * The position just before `node`'s first token, `offset` being where the
 * node starts: inside its first textblock, or before its first leaf. A block's
 * id follows that token through an edit (`page-block-ids.ts`).
 */
export function firstTokenPos(node: PMNode, offset: number): number {
  let pos = offset + 1
  let child = node.firstChild
  while (child !== null && !child.isTextblock && !child.isLeaf) {
    pos += 1
    child = child.firstChild
  }
  return child?.isTextblock === true ? pos + 1 : pos
}

/**
 * The position just before `node`'s last token: the last character of its last
 * textblock or, empty, that textblock's end, or its last leaf. The mirror of
 * `firstTokenPos`: a cut that removes both takes the block's id.
 */
export function lastTokenPos(node: PMNode, offset: number): number {
  let end = offset + node.nodeSize - 1
  let child = node.lastChild
  while (child !== null && !child.isTextblock && !child.isLeaf) {
    end -= 1
    child = child.lastChild
  }
  return child?.isTextblock === true && child.content.size > 0 ? end - 2 : end - 1
}

/** Whether `$pos` sits inside a list or a table in its block's content. */
export function insideListOrTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 1; depth -= 1) {
    const role = $pos.node(depth).type.spec['tableRole'] as string | undefined
    if ($pos.node(depth).type.name === 'listItem' || role !== undefined) return true
  }
  return false
}

/** Meta on a transaction that brings in what changed elsewhere: its ids and depths are the backend's. */
export const REMOTE_PATCH = 'pageModeRemotePatch'

export interface PageBlockSeed {
  id: string
  depth: number
  content: string | null
}

/** The page's blocks as page mode's document. A page with none opens on one new, empty block. */
export function pageDocContent(blocks: readonly PageBlockSeed[], newId: () => string): JSONContent {
  const content: JSONContent[] = blocks.map((block) => ({
    type: PAGE_BLOCK,
    attrs: { blockId: block.id, depth: block.depth },
    content: parse(block.content ?? '').content as JSONContent[],
  }))
  if (content.length === 0) {
    content.push({
      type: PAGE_BLOCK,
      attrs: { blockId: newId(), depth: 0 },
      content: [{ type: 'paragraph' }],
    })
  }
  return { type: 'doc', content }
}

/** `node`'s content as a block-mode document, the form the markdown serialiser reads. */
export function blockDocJson(node: PMNode): DocNode {
  return { type: 'doc', content: node.content.toJSON() ?? [] } as DocNode
}

/** The start of the block at `index`, or the document's end past the last. */
export function startOf(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize
  return pos
}

/** A selection end as the block it is in and how far into that block. */
export interface BlockOffset {
  id: string
  offset: number
}

function blockOffset(doc: PMNode, pos: number): BlockOffset | null {
  const $pos = doc.resolve(pos)
  if ($pos.depth < 1) return null
  return { id: blockIdOf($pos.node(1)) as string, offset: pos - $pos.before(1) }
}

/** The selection's ends, by block, to put back once the blocks have moved. */
export function selectionEnds(doc: PMNode, selection: Selection) {
  return {
    anchor: selection.anchor,
    head: selection.head,
    blocks: [blockOffset(doc, selection.anchor), blockOffset(doc, selection.head)] as const,
  }
}

/** Put the selection's ends back on the blocks they were in, wherever `tr` moved those. */
export function restoreSelection(
  tr: Transaction,
  ends: ReturnType<typeof selectionEnds>,
): Transaction {
  const find = (end: BlockOffset | null, fallback: number): number => {
    if (end === null) return fallback
    let at = -1
    tr.doc.forEach((node, pos) => {
      if (at === -1 && blockIdOf(node) === end.id) at = pos
    })
    return at === -1
      ? fallback
      : Math.min(at + end.offset, at + (tr.doc.nodeAt(at)?.nodeSize ?? 1) - 1)
  }
  const anchor = find(ends.blocks[0], tr.mapping.map(ends.anchor))
  const head = find(ends.blocks[1], tr.mapping.map(ends.head))
  return tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)))
}
