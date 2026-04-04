/**
 * TipTap extension: block_link inline node.
 *
 * Represents a page/block link ([[ULID]]) as an atomic inline node.
 * Renders as a chip showing the resolved page title. The raw ULID is
 * never visible during editing.
 *
 * Atomic inline node. Attr: id (ULID).
 *
 * Uses a NodeView (addNodeView) so we can attach a click handler for
 * navigation and conditionally apply a "deleted" style for broken links.
 * renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface BlockLinkOptions {
  /** Resolve a block/page ULID to its display title. Falls back to truncated ULID. */
  resolveTitle: (id: string) => string
  /** Called when the user clicks a block link chip. Navigates to the target page/block. */
  onNavigate?: ((id: string) => void) | undefined
  /** Check whether a linked block is active or deleted (broken link). */
  resolveStatus?: ((id: string) => 'active' | 'deleted') | undefined
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
      resolveStatus: undefined,
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
        'data-testid': 'block-link-chip',
        contenteditable: 'false',
      }),
      title,
    ]
  },

  addNodeView() {
    const extension = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs.id as string

      function render(blockId: string) {
        currentId = blockId
        const title = extension.options.resolveTitle(blockId)
        const status = extension.options.resolveStatus?.(blockId) ?? 'active'

        dom.textContent = title
        dom.className = [
          'block-link-chip',
          'cursor-pointer',
          status === 'deleted' ? 'block-link-deleted' : '',
        ]
          .filter(Boolean)
          .join(' ')
        dom.setAttribute('data-type', 'block-link')
        dom.setAttribute('data-id', blockId)
        dom.setAttribute('data-testid', 'block-link-chip')
        dom.setAttribute('contenteditable', 'false')
      }

      render(currentId)

      const clickHandler = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (dom.classList.contains('block-link-deleted')) return
        extension.options.onNavigate?.(currentId)
      }
      dom.addEventListener('click', clickHandler)

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'block_link') return false
          render(updatedNode.attrs.id as string)
          return true
        },
        destroy() {
          dom.removeEventListener('click', clickHandler)
        },
      }
    }
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
