/**
 * Have ProseMirror read the DOM selection now. End, Home and the arrows move
 * the caret in the DOM, and ProseMirror takes it in on `selectionchange`, a
 * task later; a key handled before that task, as on a busy page, would act on
 * the caret from before the move. Not for a key of an IME composition, where
 * ProseMirror holds its own reads back. `domObserver` is ProseMirror's own,
 * untyped.
 */
export function readDomSelection(view: object): void {
  ;(view as { domObserver?: { flush?: () => void } }).domObserver?.flush?.()
}
