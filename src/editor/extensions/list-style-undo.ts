/**
 * Block mode's Ctrl+Z inside the editor, after a change of a list block's kind
 * (#6156). A block whose text stops opening with a paragraph (a typed `# `,
 * `/code`, `/quote`) loses its list style once that text is saved (the page
 * store's `edit`), and the editor's history gives back the text alone. This
 * holds the style the block showed as it left its list, with the history's
 * depth just after, and the undo of exactly that change asks the block's tree
 * to write the style back (`RESTORE_LIST_STYLE`, which writes only what a save
 * took off). Nothing else brings it back: a Backspace or a Turn into is not an
 * undo, and an undo of a later change stops at another depth. A redo of the
 * change leaves the list again, and its save clears the style again.
 *
 * Page mode does the same per block (`page-lists.ts`).
 */

import { Extension } from '@tiptap/core'
import { isHistoryTransaction, undoDepth } from '@tiptap/pm/history'

import { docShowsListMarker, listMarkerPluginKey } from '@/editor/extensions/list-marker-decoration'
import type { ListStyle } from '@/lib/list-style'
import { dispatchBlockCommand } from '@/stores/block-command-bus'

interface Left {
  style: ListStyle
  depth: number
}

export const ListStyleUndo = Extension.create<object, { left: Left | null }>({
  name: 'listStyleUndo',
  addStorage: () => ({ left: null }),
  onTransaction({ transaction }) {
    const { state } = this.editor
    const history = isHistoryTransaction(transaction)
    if (!transaction.docChanged) {
      // How `mount` empties the history: what this held was the last block's.
      if (history) this.storage.left = null
      return
    }
    const style = listMarkerPluginKey.getState(state)?.style ?? 'none'
    if (!history && style === 'none') return
    const was = docShowsListMarker(transaction.before)
    const is = docShowsListMarker(state.doc)
    if (was && !is && style !== 'none') {
      this.storage.left = { style, depth: undoDepth(state) }
      return
    }
    const { left } = this.storage
    if (!was && is && history && left !== null && left.depth === undoDepth(state) + 1) {
      this.storage.left = null
      // Out of this dispatch: the tree saves the text first, which writes the page store.
      queueMicrotask(() => dispatchBlockCommand('RESTORE_LIST_STYLE', { style: left.style }))
    }
  },
})
