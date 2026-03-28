/**
 * TipTap extension: block_link inline node.
 *
 * Represents a page/block link ([[ULID]]) as an atomic inline node.
 * Renders as a chip showing the resolved page title. The raw ULID is
 * never visible during editing.
 *
 * ADR-01, ADR-20: atom:true, inline:true. Attr: id (ULID).
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface BlockLinkOptions {
  /** Resolve a block/page ULID to its display title. Falls back to truncated ULID. */
  resolveTitle: (id: string) => string
  /** Called when the user clicks a block link chip. */
  onNavigate?: (id: string) => void
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockLink: {
      insertBlockLink: (id: string) => ReturnType
    }
  }
}

export const BlockLink = Node.create<BlockLinkOptions>({
  name: 'block_link',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      resolveTitle: (id: string) => `[[${id.slice(0, 8)}...]]`,
      onNavigate: undefined,
    }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs) => ({ 'data-id': attrs.id as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="block-link"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = this.options.resolveTitle(node.attrs.id as string)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'block-link',
        class: 'block-link-chip',
        contenteditable: 'false',
      }),
      title,
    ]
  },

  addCommands() {
    return {
      insertBlockLink:
        (id: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { id } }),
    }
  },
})
