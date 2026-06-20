/**
 * `[[Page Title]]` insertion into the previously-focused element.
 * Extracted from CommandPalette.tsx (#751).
 */

import { getActiveEditor } from '@/editor/active-editor'
import { logger } from '@/lib/logger'

/**
 * Insert a `[[Page Title]]` link into the previously focused element,
 * If any. Three branches (#82):
 *   - `<input>` / `<textarea>` — native `value` splice + `input` event.
 *   - TipTap-managed contenteditable (a `.ProseMirror` descendant, the
 *     block editor's primary surface) — `editor.chain().focus()
 *     .insertContent(text).run()` via the active-editor registry. This
 *     joins the undo history and replaces the deprecated
 *     `document.execCommand('insertText')`.
 *   - any other contenteditable — Selection / Range API fallback
 *     (`range.insertNode`), which does NOT join the undo stack ("Path A"
 *     trade-off); such surfaces are rare.
 *
 * Phase 3.U8 — when the palette opened, the store snapshotted
 * the live selection range BEFORE focus moved into the palette input.
 * The TipTap branch does not need it (ProseMirror restores its own
 * selection on `.focus()`); the Range fallback restores the snapshot so
 * the insert lands at the user's original caret. For native `<input>` /
 * `<textarea>` the snapshot is not the right primitive (those elements
 * expose `selectionStart` / `selectionEnd` directly), so it is ignored.
 */
export function insertPageLinkInto(
  target: HTMLElement | null,
  pageTitle: string,
  snapshotRange: Range | null,
): boolean {
  if (target == null || !document.body.contains(target)) return false
  const text = `[[${pageTitle}]]`
  target.focus()

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    const before = target.value.slice(0, start)
    const after = target.value.slice(end)
    target.value = `${before}${text}${after}`
    const caret = start + text.length
    target.setSelectionRange(caret, caret)
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  // #82 — TipTap-managed block editor (the common case).
  // Use the editor's own command so the insertion joins the undo history;
  // `document.execCommand('insertText')` is deprecated. TipTap preserves
  // its ProseMirror selection across the palette focus excursion, so
  // `.focus()` restores the user's caret without the DOM snapshot range.
  // #1064 — `getActiveEditor()` nulls a destroyed handle at the chokepoint,
  // so a dead registry entry falls through to the Selection/Range fallback
  // below rather than throwing into the swallowing catch. The `isDestroyed`
  // short-circuit is cheap belt-and-suspenders against a destroy that races
  // this call; the try/catch stays as defense-in-depth, not the dead-handle
  // path.
  const editor = getActiveEditor()
  if (editor != null && !editor.isDestroyed && target.closest('.ProseMirror') != null) {
    try {
      editor.chain().focus().insertContent(text).run()
      return true
    } catch (err) {
      logger.warn('CommandPalette', 'failed to insert page link via TipTap', { pageTitle }, err)
      return false
    }
  }

  // Fallback for any other contenteditable surface: Selection / Range
  // API. This does NOT join the undo stack (the documented #82 "Path A"
  // trade-off), but such surfaces are rare and forward-compatibility
  // beats undo fidelity here.
  if (target.isContentEditable) {
    // Phase 3.U8 — restore the snapshotted caret position first,
    // but only if its container is still in the live DOM (the user may
    // have edited the document while the palette was open).
    if (snapshotRange != null) {
      try {
        const container = snapshotRange.startContainer
        if (
          container.nodeType === Node.TEXT_NODE
            ? container.parentElement != null && document.body.contains(container.parentElement)
            : container instanceof Element && document.body.contains(container)
        ) {
          const sel = document.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(snapshotRange)
        }
      } catch (err) {
        // Restoring the range can throw if the DOM has shifted under us
        // (e.g. a block was deleted while the palette was open).
        logger.warn('CommandPalette', 'snapshot range restoration failed', { pageTitle }, err)
      }
    }
    try {
      const sel = document.getSelection()
      if (sel == null || sel.rangeCount === 0) return false
      const range = sel.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      // Collapse the caret to just after the inserted text.
      range.setStartAfter(node)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    } catch (err) {
      logger.warn('CommandPalette', 'failed to insert page link', { pageTitle }, err)
      return false
    }
  }
  return false
}
