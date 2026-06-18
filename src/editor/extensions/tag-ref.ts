/**
 * TipTap extension: tag_ref inline node.
 *
 * Represents a tag reference (#[ULID]) as an atomic inline node.
 * Renders as a chip showing the resolved tag name. The raw ULID is
 * never visible during editing.
 *
 * Atomic inline node. Attr: id (ULID).
 *
 * Uses a NodeView (addNodeView) for color styling and click/keyboard
 * interaction. renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'

import { getTagColor } from '@/lib/tag-colors'

export interface TagRefOptions {
  /** Resolve a tag ULID to its display name. Falls back to truncated ULID. */
  resolveName: (id: string) => string
  /**
   * Called when the user clicks (or activates via Enter / Space on) a tag
   * chip inside the editor. When omitted the chip stays a plain decoration
   * with no pointer / keyboard affordance.
   */
  onClick?: ((id: string) => void) | undefined
  /** PEND-15 Phase 4 — no-op; kept for test backward compat. Remove in Phase 5. */
  resolveStatus?: ((id: string) => 'active' | 'deleted') | undefined
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
      onClick: undefined,
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
    return [{ tag: 'span[data-type="tag-ref"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = this.options.resolveName(node.attrs['id'] as string)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'tag-ref',
        class: 'tag-ref-chip',
        'data-testid': 'tag-ref-chip',
        contenteditable: 'false',
      }),
      name,
    ]
  },

  addNodeView() {
    const { options } = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs['id'] as string

      function render(tagId: string) {
        currentId = tagId
        const name = options.resolveName(tagId)
        const color = getTagColor(tagId)

        dom.textContent = name
        dom.className = 'tag-ref-chip'
        dom.setAttribute('data-type', 'tag-ref')
        dom.setAttribute('data-id', currentId)
        dom.setAttribute('data-testid', 'tag-ref-chip')
        dom.setAttribute('contenteditable', 'false')

        if (color) {
          dom.style.backgroundColor = `${color}20`
          dom.style.color = color
        } else {
          dom.style.backgroundColor = ''
          dom.style.color = ''
        }
      }

      render(currentId)

      // Register click / keydown listeners ONCE in the outer closure so every
      // NodeView `update()` (which calls `render()`) does not leak a fresh
      // handler. The listeners read `currentId` (mutated by render) and
      // `options.onClick` (the current configured handler), so they
      // always see the latest id and callback.
      const clickHandler = (event: MouseEvent) => {
        const onClick = options.onClick
        if (!onClick) return
        // #924 — match block-link / block-ref: preventDefault as well as
        // stopPropagation so the click navigates without ProseMirror also
        // placing the caret inside the chip.
        event.preventDefault()
        event.stopPropagation()
        onClick(currentId)
      }
      const keydownHandler = (event: KeyboardEvent) => {
        const onClick = options.onClick
        if (!onClick) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        onClick(currentId)
      }
      dom.addEventListener('click', clickHandler)
      dom.addEventListener('keydown', keydownHandler)

      // Only expose keyboard affordances when an onClick is wired — without
      // it the chip stays a plain decoration.
      if (options.onClick) {
        dom.setAttribute('role', 'link')
        dom.setAttribute('tabindex', '0')
      }

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'tag_ref') return false
          render(updatedNode.attrs['id'] as string)
          return true
        },
        destroy() {
          dom.removeEventListener('click', clickHandler)
          dom.removeEventListener('keydown', keydownHandler)
        },
      }
    }
  },

  addCommands() {
    return {
      insertTagRef:
        (id: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { id } }),
    }
  },

  addKeyboardShortcuts() {
    return {
      // Backspace immediately after a tag_ref chip deletes the whole chip
      // atom in one keystroke (the default ProseMirror behaviour would only
      // select it). We do NOT re-expand it to `@name` text: the @ suggestion
      // plugin only reopens when the user types the trigger char, not when it
      // is inserted programmatically, so re-inserting plain text would leave
      // an inert `@name` string behind. Deleting cleanly is the honest
      // behaviour; the user can retype `@` to open the picker again.
      Backspace: () => {
        const { selection } = this.editor.state
        if (!selection.empty) return false
        const { $from } = selection
        const nodeBefore = $from.nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'tag_ref') return false

        const from = $from.pos - nodeBefore.nodeSize
        const to = $from.pos

        this.editor.chain().focus().deleteRange({ from, to }).run()

        return true
      },
    }
  },
})
