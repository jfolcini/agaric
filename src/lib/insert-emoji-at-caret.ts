/**
 * #286 — insert a native emoji at the caret in plain-text surfaces.
 *
 * Unlike `editor/insert-emoji.ts` (which routes through the roving TipTap
 * editor's `insertContent` command), the page-title contentEditable and the
 * tag-name `<input>` are not editors — they hold plain Unicode text. These
 * helpers splice the emoji into the surface's current value at the caret
 * offset and return the new string plus the caret position *after* the
 * inserted emoji, so the caller can update its controlled state and restore
 * the selection.
 *
 * Both helpers are pure (they read the live selection but do not mutate the
 * DOM); the caller owns the state update + focus restoration. This keeps them
 * trivially unit-testable and lets each surface manage its own controlled
 * value the way it already does.
 */

export interface CaretInsertResult {
  /** The surface's full text after the emoji was spliced in. */
  readonly value: string
  /** Caret offset (in JS string indices) immediately after the inserted emoji. */
  readonly caret: number
}

/**
 * Splice `emoji` into `value` at `[start, end)`, replacing any selected range.
 * `start`/`end` default to the end of `value` (append) when the caret is
 * unknown — the common case when focus has moved to the picker dialog and the
 * original selection was not captured.
 */
export function spliceEmojiIntoText(
  value: string,
  emoji: string,
  start: number = value.length,
  end: number = start,
): CaretInsertResult {
  const lo = Math.max(0, Math.min(start, value.length))
  const hi = Math.max(lo, Math.min(end, value.length))
  const next = value.slice(0, lo) + emoji + value.slice(hi)
  return { value: next, caret: lo + emoji.length }
}

/**
 * Insert `emoji` into a text/`<input>`/`<textarea>` element at its current
 * selection, updating the element's `value` and moving the caret after the
 * emoji. Returns the new value (for syncing controlled state). Falls back to
 * appending when the element has no usable selection.
 */
export function insertEmojiIntoInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  emoji: string,
): string {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const { value, caret } = spliceEmojiIntoText(el.value, emoji, start, end)
  el.value = value
  // Restore the caret after the emoji so a follow-up keystroke continues from
  // the right place.
  el.setSelectionRange(caret, caret)
  return value
}
