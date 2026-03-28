/**
 * TipTap extension: tag_ref inline node.
 *
 * Represents a tag reference (#[ULID]) as an atomic inline node.
 * Renders as a chip showing the resolved tag name. The raw ULID is
 * never visible during editing.
 *
 * ADR-01, ADR-20: atom:true, inline:true. Attr: id (ULID).
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface TagRefOptions {
  /** Resolve a tag ULID to its display name. Falls back to truncated ULID. */
  resolveName: (id: string) => string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tagRef: {
      insertTagRef: (id: string) => ReturnType
    }
  }
}

export const TagRef = Node.create<TagRefOptions>({
  name: 'tag_ref',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      resolveName: (id: string) => `#${id.slice(0, 8)}...`,
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
    return [{ tag: 'span[data-type="tag-ref"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = this.options.resolveName(node.attrs.id as string)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'tag-ref',
        class: 'tag-ref-chip',
        contenteditable: 'false',
      }),
      name,
    ]
  },

  addCommands() {
    return {
      insertTagRef:
        (id: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { id } }),
    }
  },
})
