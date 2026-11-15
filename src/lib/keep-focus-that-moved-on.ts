/**
 * An `onCloseAutoFocus` for a Radix popover or sheet whose close can hand the
 * focus to something else first. Radix refocuses the trigger one timer after
 * the content unmounts, after the close animation; by then the focus may have
 * moved on (a block editor the user clicked into, a row's input), and taking
 * it back blurs that element. The trigger gets the focus only when the close
 * left it nowhere.
 */
export function keepFocusThatMovedOn(event: Event): void {
  const focused = document.activeElement
  if (focused != null && focused !== document.body) event.preventDefault()
}
