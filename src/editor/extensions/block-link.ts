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
 * Uses a NodeView (addNodeView) so we can attach a click handler that
 * navigates. A broken link (`resolveStatus` says `'deleted'`) renders the
 * static renderer's `BrokenBlockLink` through `ReactRenderer` instead: a tap
 * explains it, and its Remove button removes it (#6895). renderHTML is kept
 * for copy-paste / serialization.
 *
 * A page dragged in from a list (`page-drag.ts`) lands as a link where it is
 * dropped, in block mode and page mode alike.
 */

import { type Editor, mergeAttributes, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import type { ComponentProps } from 'react'

import { BrokenBlockLink } from '@/components/RichContentRenderer/marks/blockLink'
import { storableLinkLabel } from '@/editor/markdown-common'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { droppedPageId } from '@/lib/page-drag'

export interface BlockLinkOptions {
  /** Resolve a block/page ULID to its display title. Falls back to truncated ULID. */
  resolveTitle: (id: string) => string
  /** Called when the user clicks a block link chip. Navigates to the target page/block. */
  onNavigate?: ((id: string) => void) | undefined
  /** A `'deleted'` link is broken: clicking it explains it, with a Remove button, instead of navigating. */
  resolveStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

/**
 * Replace the chip at `pos` with its label as plain text, or drop it when it
 * has none: the label is the block's own text, the title the target's. One
 * transaction, a history step of its own even right after typing, so the
 * editor's undo restores the link and only the link. Remove is pressed while
 * the popover shows, so the chip may be gone, or no longer broken, by then:
 * `pos` is resolved at the press, and a chip that no longer holds a broken
 * link is left alone.
 */
function removeBrokenLink(editor: Editor, pos: number | undefined, broken: boolean): void {
  const chip = editor.isDestroyed || pos === undefined ? null : editor.state.doc.nodeAt(pos)
  if (pos === undefined || chip?.type.name !== 'block_link' || !broken) {
    logger.warn('BlockLink', 'broken link changed before Remove was pressed; left alone')
    return
  }
  const label = chip.attrs['label'] as string | null
  const tr = editor.state.tr
  if (label === null) tr.delete(pos, pos + chip.nodeSize)
  else tr.replaceWith(pos, pos + chip.nodeSize, editor.schema.text(label, chip.marks))
  editor.view.dispatch(closeHistory(tr))
  editor.commands.focus()
  notify.success(t('editor.brokenLinkRemoved'))
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
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('span')
      dom.setAttribute('contenteditable', 'false')
      let currentId = node.attrs['id'] as string
      const isBroken = (id: string) => options.resolveStatus?.(id) === 'deleted'
      let brokenChip: ReactRenderer<unknown, ComponentProps<typeof BrokenBlockLink>> | null = null

      function renderBroken(blockId: string, label: string | null) {
        // The static block's broken chip, so both read and act alike.
        const props = {
          node: {
            type: 'block_link' as const,
            attrs: label === null ? { id: blockId } : { id: blockId, label },
          },
          label: label ?? options.resolveTitle(blockId),
          anchored: false,
          remove: () => removeBrokenLink(editor, getPos(), isBroken(currentId)),
          focusEditor: () => {
            if (!editor.isDestroyed) editor.commands.focus()
          },
        }
        if (brokenChip !== null) {
          brokenChip.updateProps(props)
          return
        }
        for (const attr of ['class', 'data-type', 'data-id', 'data-testid', 'data-label', 'title'])
          dom.removeAttribute(attr)
        dom.textContent = ''
        brokenChip = new ReactRenderer(BrokenBlockLink, { editor, props, as: 'span' })
        dom.append(brokenChip.element)
      }

      function render(blockId: string, label: string | null) {
        currentId = blockId
        if (isBroken(blockId)) {
          renderBroken(blockId, label)
          return
        }
        brokenChip?.destroy()
        brokenChip = null
        const title = options.resolveTitle(blockId)
        // A label stands in for the title (#5160 D9), which the tooltip
        // then keeps reachable: shortened text, the native title's second
        // sanctioned case; a chip showing its full title carries none (#6895).
        dom.textContent = label ?? title
        dom.className = 'block-link-chip cursor-pointer'
        dom.setAttribute('data-type', 'block-link')
        dom.setAttribute('data-id', blockId)
        dom.setAttribute('data-testid', 'block-link-chip')
        if (label === null) {
          dom.removeAttribute('data-label')
          dom.removeAttribute('title')
        } else {
          dom.setAttribute('data-label', label)
          dom.setAttribute('title', title)
        }
      }

      render(currentId, (node.attrs['label'] as string | null) ?? null)

      const clickHandler = (e: MouseEvent) => {
        if (brokenChip !== null) return
        e.preventDefault()
        e.stopPropagation()
        options.onNavigate?.(currentId)
      }
      dom.addEventListener('click', clickHandler)

      return {
        dom,
        // The broken chip's button and its keys are its own: ProseMirror would
        // select the node on the press and split the block on Enter.
        stopEvent: () => brokenChip !== null,
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
          brokenChip?.destroy()
        },
      }
    }
  },

  addCommands() {
    return {
      insertBlockLink:
        (id: string, label?: string) =>
        ({ commands }) => {
          const stored = storableLinkLabel(label)
          return commands.insertContent({
            type: this.name,
            attrs: stored ? { id, label: stored } : { id },
          })
        },
      setBlockLinkLabel:
        (label: string) =>
        ({ state, commands }) => {
          // Duck-typed NodeSelection: `instanceof` against `@tiptap/pm/state`
          // is unreliable across bundle copies.
          const { selection } = state
          const node = 'node' in selection ? (selection.node as ProseMirrorNode) : null
          if (!node || node.type.name !== this.name) return false
          const stored = storableLinkLabel(label)
          const title = this.options.resolveTitle(node.attrs['id'] as string)
          return commands.updateAttributes(this.name, {
            label: stored === undefined || stored === title ? null : stored,
          })
        },
    }
  },

  addProseMirrorPlugins() {
    const { type } = this
    return [
      new Plugin({
        props: {
          handleDrop(view, event) {
            const pageId = droppedPageId(event.dataTransfer)
            if (pageId === null) return false
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
            const tr = view.state.tr
            const near = TextSelection.near(tr.doc.resolve(at?.pos ?? tr.selection.from))
            const { $from } = near
            // A code block holds no link: inserting one there would split the
            // code in two, so the drop is taken and dropped.
            if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return true
            tr.setSelection(near)
            tr.replaceSelectionWith(type.create({ id: pageId }), false)
            view.dispatch(tr.setMeta('uiEvent', 'drop'))
            view.focus()
            return true
          },
        },
      }),
    ]
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
