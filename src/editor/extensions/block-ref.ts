/**
 * TipTap extension: block_ref inline node.
 *
 * Represents a block reference ((ULID)) as an atomic inline node.
 * Renders as a chip showing the first line of the referenced block's
 * content. The raw ULID is never visible during editing.
 *
 * Atomic inline node. Attr: id (ULID).
 *
 * Uses a NodeView (addNodeView) so we can attach a click handler for
 * navigation and conditionally apply a "deleted" style for broken refs.
 * renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface BlockRefOptions {
  /** Resolve a block ULID to the first line of its content. Falls back to truncated ULID. */
  resolveContent: (id: string) => string
  /** Called when the user clicks a block ref chip. Navigates to the target block. */
  onNavigate?: ((id: string) => void) | undefined
  /** Check whether a referenced block is active or deleted (broken ref). */
  resolveStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockRef: {
      insertBlockRef: (id: string) => ReturnType
    }
  }
}

export const BlockRef = Node.create<BlockRefOptions>({
  name: 'block_ref',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      resolveContent: (id: string) => `(( ${id.slice(0, 8)}... ))`,
      onNavigate: undefined,
      resolveStatus: undefined,
    }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs) => ({ 'data-id': attrs['id'] as string }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="block-ref"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const content = this.options.resolveContent(node.attrs['id'] as string)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'block-ref',
        class: 'block-ref-chip',
        'data-testid': 'block-ref-chip',
        contenteditable: 'false',
      }),
      content,
    ]
  },

  addNodeView() {
    const extension = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs['id'] as string

      function render(blockId: string) {
        currentId = blockId
        const content = extension.options.resolveContent(blockId)
        const status = extension.options.resolveStatus?.(blockId) ?? 'active'

        dom.textContent = content
        dom.className = [
          'block-ref-chip',
          'cursor-pointer',
          status === 'deleted' ? 'block-ref-deleted' : '',
        ]
          .filter(Boolean)
          .join(' ')
        dom.setAttribute('data-type', 'block-ref')
        dom.setAttribute('data-id', blockId)
        dom.setAttribute('data-testid', 'block-ref-chip')
        dom.setAttribute('contenteditable', 'false')
        if (status === 'deleted') {
          dom.setAttribute('title', 'Broken ref — target block deleted')
        } else {
          dom.removeAttribute('title')
        }
      }

      render(currentId)

      const clickHandler = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (dom.classList.contains('block-ref-deleted')) return
        extension.options.onNavigate?.(currentId)
      }
      dom.addEventListener('click', clickHandler)

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'block_ref') return false
          render(updatedNode.attrs['id'] as string)
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
      insertBlockRef:
        (id: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { id } }),
    }
  },

  addKeyboardShortcuts() {
    return {
      // B-66: Backspace on a block_ref chip re-expands it to ((content text,
      // letting the suggestion plugin reopen for editing the reference.
      Backspace: () => {
        const { $from } = this.editor.state.selection
        const nodeBefore = $from.nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'block_ref') return false

        const id = nodeBefore.attrs['id'] as string
        const content = this.options.resolveContent(id)
        const nodeSize = nodeBefore.nodeSize
        const from = $from.pos - nodeSize
        const to = $from.pos

        this.editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContentAt(from, `((${content}`)
          .run()

        return true
      },
    }
  },
})
