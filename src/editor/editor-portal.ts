/**
 * Opt-in for transient UI elements (popups, toolbars, pickers) that must NOT
 * unmount the editor when they receive focus: put `data-editor-portal` on the
 * overlay's outermost element.
 */
export const EDITOR_PORTAL_SELECTOR = '[data-editor-portal]'

/**
 * Whether focus leaving `wrapper` (the editor and its toolbar) for `related`
 * (none: nowhere) leaves it still being edited: focus moved to an overlay marked
 * `data-editor-portal`, or stayed in the wrapper, or such an overlay outside the
 * wrapper still shows. One inside the wrapper goes with the editor, so it never
 * holds a blur from outside (B-56). Radix leaves a closed overlay mounted but
 * hidden, which `checkVisibility` sees.
 */
export function focusStaysInEditor(wrapper: HTMLElement, related: Element | null): boolean {
  if (related?.closest(EDITOR_PORTAL_SELECTOR)) return true
  if (wrapper.contains(related)) return true
  return Array.from(document.querySelectorAll<HTMLElement>(EDITOR_PORTAL_SELECTOR)).some((el) => {
    if (wrapper.contains(el)) return false
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    }
    return el.offsetParent !== null
  })
}
