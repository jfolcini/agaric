/**
 * #82 — active-editor registry.
 *
 * Each `BlockTree` runs one roving TipTap instance (AGENTS.md invariant
 * 4), but the app can mount several BlockTrees at once (the journal
 * week and stream views render one per day; the month view is a calendar
 * grid and mounts none). App-level UI outside the tree —
 * notably the command palette's `[[Page]]` link insertion — needs the
 * live `Editor` to run undo-preserving commands (`insertContent`) instead
 * of the deprecated `document.execCommand('insertText')`, without
 * prop-drilling a ref through unrelated components.
 *
 * This holds the **most-recently-focused** roving editor: each BlockTree
 * publishes its instance on the editor's `focus` event (not on mount, so
 * the value tracks the caret rather than mount order), and clears it on
 * unmount only if still current. Consumers must tolerate `null` (no block
 * has been focused / the last one unmounted).
 */
import type { Editor } from '@tiptap/react'

import { parse } from '@/editor/markdown-serializer'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { logger } from '@/lib/logger'

/** What a reload reads of a block tree's roving editor to hand it the block's new text. */
type RovingText = Pick<
  RovingEditorHandle,
  'activeBlockId' | 'getMarkdown' | 'storedMarkdown' | 'markCommitted'
>

let activeEditor: Editor | null = null
let activeRoving: RovingText | null = null

/**
 * Publish the single roving editor instance (or clear it with `null`), with
 * the roving handle it belongs to; page mode's editor has none.
 *
 * #1064 — reject a destroyed editor outright: a teardown that races the
 * focus-event publish must never seed the registry with a dead handle.
 */
export function setActiveEditor(editor: Editor | null, roving: RovingText | null = null): void {
  activeEditor = editor?.isDestroyed === true ? null : editor
  activeRoving = activeEditor === null ? null : roving
}

/**
 * The live roving editor, or `null` when none is mounted/focused.
 *
 * #1064 — liveness chokepoint: any teardown that does not route through
 * BlockTree's guarded unmount clear (an exception-driven tree swap, or an
 * `editor.destroy()` that races the focus-event publish) can leave a
 * destroyed `Editor` cached here. We never hand a dead handle to consumers:
 * if the cached editor `isDestroyed`, clear the stale ref and return `null`
 * so insert helpers degrade cleanly instead of throwing into a swallowing
 * catch. We use `Editor.isDestroyed`, not `editor.view.isDestroyed`: in
 * TipTap v3 `editor.view` is a Proxy stub once destroyed whose `isDestroyed`
 * reports `false`, missing the `editor.destroy()`-before-cleanup case this
 * bug is about (#1017). `Editor.isDestroyed` returns `editorView?.isDestroyed
 * ?? true`, covering both a destroyed view and a fully destroyed editor.
 */
export function getActiveEditor(): Editor | null {
  if (activeEditor?.isDestroyed === true) {
    activeEditor = null
  }
  return activeEditor
}

/**
 * #6533 — give a reload's text for `blockId` to the roving editor mounted on
 * it, when nothing typed there is uncommitted: the document is replaced out of
 * undo history, the selection is kept where it still fits, and the commit
 * baseline becomes `markdown`. Returns false, changing nothing, when the editor
 * holds uncommitted text or no live roving editor is on the block (a lazy
 * editor's buffered mount still holds the text it was given): the caller keeps
 * the text the editor started from.
 */
export function takeReloadedText(blockId: string, markdown: string): boolean {
  const editor = getActiveEditor()
  const roving = editor === null ? null : activeRoving
  if (editor === null || roving?.activeBlockId !== blockId) return false
  if (roving.getMarkdown() !== roving.storedMarkdown) return false
  try {
    const { from, to } = editor.state.selection
    const doc = editor.schema.nodeFromJSON(parse(markdown))
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content)
    // Not typing: no undo entry, and no update signal to arm the commit or the draft.
    tr.setMeta('addToHistory', false).setMeta('preventUpdate', true)
    editor.view.dispatch(tr)
    editor.commands.setTextSelection({ from, to })
  } catch (err) {
    logger.warn('editor', 'reloaded text not taken by the editor', { blockId }, err)
    return false
  }
  roving.markCommitted(markdown)
  return true
}
