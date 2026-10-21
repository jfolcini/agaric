/**
 * Opt-in for transient UI elements (popups, toolbars, pickers) that must NOT
 * unmount the editor when they receive focus: put `data-editor-portal` on the
 * overlay's outermost element.
 */
export const EDITOR_PORTAL_SELECTOR = '[data-editor-portal]'
