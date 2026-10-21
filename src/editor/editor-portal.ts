/**
 * Single-attribute opt-in for transient UI elements (popups, toolbars,
 * pickers) that should NOT cause the editor to unmount when they receive
 * focus. New overlays opt in via markup — `<div data-editor-portal>…` —
 * Instead of editing a hardcoded selector list.
 *
 * The legacy `EDITOR_PORTAL_SELECTORS` array (8 class selectors) is gone:
 * `.suggestion-popup`, `.suggestion-list`, `.formatting-toolbar`, `.rdp`
 * (the react-day-picker root — we tag our `Calendar` wrapper instead),
 * `.date-picker-popup`, `.property-key-editor`, `.block-context-menu`
 * all carry `data-editor-portal=""` on their outermost portal element.
 *
 * Tests / external code that historically imported the array can use
 * this selector string instead.
 */
export const EDITOR_PORTAL_SELECTOR = '[data-editor-portal]'
