/**
 * TipTap extension: block_link inline node.
 *
 * Represents a page/block link ([[ULID]], or [[ULID|label]]) as an atomic
 * inline node. Renders as a chip showing the label, else the resolved page
 * title. The raw ULID is never visible during editing.
 *
 * Atomic inline node. Attrs: id (ULID), label (#5160 D9; null when none, and
 * never the target's own title, which `setBlockLinkLabel` drops).
 *
 * Uses a NodeView (addNodeView) so we can attach a click handler for
 * navigation. renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface BlockLinkOptions {
  /** Resolve a block/page ULID to its display title. Falls back to truncated ULID. */
  resolveTitle: (id: string) => string
  /** Called when the user clicks a block link chip. Navigates to the target page/block. */
  onNavigate?: ((id: string) => void) | undefined
  /** Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockLink: {
      insertBlockLink: (id: string, label?: string) => ReturnType
      /**
       * Set the selected chip's label: trimmed, without `]` (the stored token
       * would read as text), and dropped when empty or equal to the target's
       * title (#5160 D9). False when no chip is selected.
       */
      setBlockLinkLabel: (label: string) => ReturnType
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
        renderHTML: (attrs) => ({ 'data-id': attrs['id'] as string }),
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs) =>
          typeof attrs['label'] === 'string' ? { 'data-label': attrs['label'] } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="block-link"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title =
      (node.attrs['label'] as string | null) ??
      this.options.resolveTitle(node.attrs['id'] as string)
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
    const { options } = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs['id'] as string

      function render(blockId: string, label: string | null) {
        currentId = blockId
        const title = options.resolveTitle(blockId)

        // A label stands in for the title (#5160 D9), which the tooltip
        // then keeps reachable.
        dom.textContent = label ?? title
        dom.className = 'block-link-chip cursor-pointer'
        dom.setAttribute('data-type', 'block-link')
        dom.setAttribute('data-id', blockId)
        dom.setAttribute('data-testid', 'block-link-chip')
        dom.setAttribute('contenteditable', 'false')
        if (label === null) {
          dom.removeAttribute('title')
          dom.removeAttribute('data-label')
        } else {
          dom.setAttribute('title', title)
          dom.setAttribute('data-label', label)
        }
      }

      render(currentId, (node.attrs['label'] as string | null) ?? null)

      const clickHandler = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        options.onNavigate?.(currentId)
      }
      dom.addEventListener('click', clickHandler)

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'block_link') return false
          render(
            updatedNode.attrs['id'] as string,
            (updatedNode.attrs['label'] as string | null) ?? null,
          )
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
        (id: string, label?: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: label ? { id, label } : { id } }),
      setBlockLinkLabel:
        (label: string) =>
        ({ state, commands }) => {
          // Duck-typed NodeSelection: `instanceof` against `@tiptap/pm/state`
          // is unreliable across bundle copies.
          const { selection } = state
          const node = 'node' in selection ? (selection.node as ProseMirrorNode) : null
          if (!node || node.type.name !== this.name) return false
          const trimmed = label.replaceAll(']', '').trim()
          const title = this.options.resolveTitle(node.attrs['id'] as string)
          return commands.updateAttributes(this.name, {
            label: trimmed === '' || trimmed === title ? null : trimmed,
          })
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      // Backspace immediately after a block_link chip deletes the whole chip
      // atom in one keystroke (the default ProseMirror behaviour would only
      // select it). We do NOT re-expand it to `[[title` text: the [[ suggestion
      // plugin only reopens when the user types the trigger char, not when it
      // is inserted programmatically, so re-inserting plain text would leave an
      // inert `[[title` string (with a dangling open bracket) behind. Deleting
      // cleanly is the honest behaviour; the user can retype `[[` to open the
      // picker again.
      Backspace: () => {
        const { selection } = this.editor.state
        if (!selection.empty) return false
        const { $from } = selection
        const nodeBefore = $from.nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'block_link') return false

        const from = $from.pos - nodeBefore.nodeSize
        const to = $from.pos

        this.editor.chain().focus().deleteRange({ from, to }).run()

        return true
      },
    }
  },
})
