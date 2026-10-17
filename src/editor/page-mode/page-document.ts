/**
 * Page mode's document (#5691): one ProseMirror document for the whole page, a
 * flat run of `pageBlock(blockId, depth)` nodes. Each holds what one block holds
 * in block mode, under the same content nodes, so a block's markdown is its
 * node's content serialised as a block-mode document. Depth stands in for the
 * tree: a block's parent is the nearest block before it one level up, as in the
 * page store's `FlatBlock[]`.
 */

import { type JSONContent, Node } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

import { parse } from '@/editor/markdown-serializer'
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
                style: `padding-left: calc(var(--indent-width) * ${depth})`,
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

export function blockIdOf(node: PMNode): string | null {
  return (node.attrs['blockId'] as string | null | undefined) ?? null
}

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
