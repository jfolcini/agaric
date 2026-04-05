/**
 * TipTap extension: tag_ref inline node.
 *
 * Represents a tag reference (#[ULID]) as an atomic inline node.
 * Renders as a chip showing the resolved tag name. The raw ULID is
 * never visible during editing.
 *
 * Atomic inline node. Attr: id (ULID).
 *
 * Uses a NodeView (addNodeView) so we can conditionally apply a
 * "deleted" style for tags that have been soft-deleted.
 * renderHTML is kept for copy-paste / serialization.
 */

import { mergeAttributes, Node } from '@tiptap/core'

export interface TagRefOptions {
  /** Resolve a tag ULID to its display name. Falls back to truncated ULID. */
  resolveName: (id: string) => string
  /** Check whether a referenced tag is active or deleted. */
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
    return [{ tag: 'span[data-type="tag-ref"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = this.options.resolveName(node.attrs.id as string)
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
    const extension = this
    return ({ node }) => {
      const dom = document.createElement('span')
      let currentId = node.attrs.id as string

      function render(tagId: string) {
        currentId = tagId
        const name = extension.options.resolveName(tagId)
        const status = extension.options.resolveStatus?.(tagId) ?? 'active'

        dom.textContent = name
        dom.className = ['tag-ref-chip', status === 'deleted' ? 'tag-ref-deleted' : '']
          .filter(Boolean)
          .join(' ')
        dom.setAttribute('data-type', 'tag-ref')
        dom.setAttribute('data-id', currentId)
        dom.setAttribute('data-testid', 'tag-ref-chip')
        dom.setAttribute('contenteditable', 'false')
      }

      render(currentId)

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'tag_ref') return false
          render(updatedNode.attrs.id as string)
          return true
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
      // H-14: Backspace on a tag_ref chip re-expands it to @name text,
      // letting the suggestion plugin reopen for editing the reference.
      Backspace: () => {
        const { $from } = this.editor.state.selection
        const nodeBefore = $from.nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'tag_ref') return false

        const id = nodeBefore.attrs.id as string
        const name = this.options.resolveName(id)
        const nodeSize = nodeBefore.nodeSize
        const from = $from.pos - nodeSize
        const to = $from.pos

        this.editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContentAt(from, `@${name}`)
          .run()

        return true
      },
    }
  },
})
