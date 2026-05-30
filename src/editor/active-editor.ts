/**
 * #82 (PEND-66) — active-editor registry.
 *
 * Each `BlockTree` runs one roving TipTap instance (AGENTS.md invariant
 * 4), but the app can mount several BlockTrees at once (the journal
 * week/month views render one per day). App-level UI outside the tree —
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

let activeEditor: Editor | null = null

/** Publish the single roving editor instance (or clear it with `null`). */
export function setActiveEditor(editor: Editor | null): void {
  activeEditor = editor
}

/** The live roving editor, or `null` when none is mounted/focused. */
export function getActiveEditor(): Editor | null {
  return activeEditor
}
