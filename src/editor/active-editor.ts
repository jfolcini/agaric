/**
 * #82 — active-editor registry.
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

/**
 * Publish the single roving editor instance (or clear it with `null`).
 *
 * #1064 — reject a destroyed editor outright: a teardown that races the
 * focus-event publish must never seed the registry with a dead handle.
 */
export function setActiveEditor(editor: Editor | null): void {
  activeEditor = editor?.isDestroyed === true ? null : editor
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
