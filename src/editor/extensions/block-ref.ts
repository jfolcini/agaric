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
 * navigation. renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface BlockRefOptions {
  /** Resolve a block ULID to the first line of its content. Falls back to truncated ULID. */
  resolveContent: (id: string) => string
  /** Called when the user clicks a block ref chip. Navigates to the target block. */
  onNavigate?: ((id: string) => void) | undefined
  /** Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
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
    const { options } = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs['id'] as string

      function render(blockId: string) {
        currentId = blockId
        const content = options.resolveContent(blockId)

        dom.textContent = content
        dom.className = 'block-ref-chip cursor-pointer'
        dom.setAttribute('data-type', 'block-ref')
        dom.setAttribute('data-id', blockId)
        dom.setAttribute('data-testid', 'block-ref-chip')
        dom.setAttribute('contenteditable', 'false')
      }

      render(currentId)

      const clickHandler = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        options.onNavigate?.(currentId)
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
      // B-66 (#1739): Backspace immediately after a block_ref chip deletes the
      // whole chip atom in one keystroke. We do NOT re-expand it to `((content`
      // text: the `((` suggestion plugin only reopens when the user types the
      // trigger char, not when it is inserted programmatically, so re-inserting
      // plain text would leave an inert `((content` string (with a dangling open
      // bracket) behind. Deleting cleanly is the honest behaviour; the user can
      // retype `((` to open the picker again. (Matches tag_ref / block_link.)
      Backspace: () => {
        const { selection } = this.editor.state
        if (!selection.empty) return false
        const { $from } = selection
        const nodeBefore = $from.nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'block_ref') return false

        const from = $from.pos - nodeBefore.nodeSize
        const to = $from.pos

        this.editor.chain().focus().deleteRange({ from, to }).run()

        return true
      },
    }
  },
})
