/**
 * Built-in Android back-chain steps (#716): overlay-close and in-app
 * navigation. Registered by `useAndroidBackButton` at
 * `BACK_PRIORITY_OVERLAY` / `BACK_PRIORITY_NAVIGATION`; the middle band
 * (`BACK_PRIORITY_ZOOM`) is registered dynamically by `useBlockZoom`
 * while a BlockTree is zoomed.
 */

import { useNavigationStore } from '../stores/navigation'
import { useTabsStore } from '../stores/tabs'

/**
 * Radix-rendered overlay surfaces that should swallow a back press.
 * Scoped to interactive overlay roles — `data-state="open"` alone would
 * also match collapsibles / accordions / tooltips, which must NOT count.
 * Covers Dialog + AlertDialog (and the Sheet built on Dialog), Popover
 * (renders `role="dialog"`), DropdownMenu / ContextMenu (`role="menu"`)
 * and Select (`role="listbox"`).
 */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(', ')

/**
 * Step 1 — overlay close. If any overlay is open, dispatch a synthetic
 * Escape `keydown` on the focused element (`document.activeElement`,
 * falling back to `document.body`) and report the press as consumed.
 *
 * One synthetic Escape drives ALL existing dismiss paths at once:
 *  - Radix's DismissableLayer document-capture listener closes the
 *    TOPMOST Radix layer only (dialogs stack correctly under repeated
 *    presses) — it fires for any target, so the dispatch node barely
 *    matters for Radix itself;
 *  - React `onKeyDown` Escape handlers (e.g. the palette action menu,
 *    which `preventDefault`s Radix's escape via `onEscapeKeyDown` and
 *    closes itself instead). React ≥17 delegates events at root/portal
 *    containers, so an event dispatched on `document.body` NEVER
 *    reaches React handlers — its path (body → html → document) skips
 *    every container. A real hardware Escape targets the focused
 *    element; dispatching on `activeElement` reproduces that path and
 *    keeps such inner-layer handlers working (otherwise back presses
 *    would be consumed with no visible effect while, say, the palette
 *    action menu is open — a dead back button);
 *  - the app-level `closeOverlays` bridge in `useAppKeyboardShortcuts`
 *    matches the same event at `window` and dispatches
 *    `CLOSE_ALL_OVERLAYS_EVENT` for non-Radix overlays (and announces
 *    to screen readers).
 *
 * This deliberately reuses the Escape semantics users already have on
 * desktop instead of inventing a second dismiss protocol.
 */
export function overlayBackHandler(): boolean {
  if (typeof document === 'undefined') return false
  if (document.querySelector(OPEN_OVERLAY_SELECTOR) === null) return false
  const target = document.activeElement ?? document.body
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  )
  return true
}

/**
 * Step 3 — in-app navigation. Mirrors Android's "progressive collapse to
 * the start destination" convention:
 *
 *  - `page-editor` with a non-empty page stack → `useTabsStore.goBack()`
 *    (pops the stack; closes the tab / falls back to `pages` view at the
 *    stack bottom, exactly like the in-app back button).
 *  - any non-`journal` view (settings, pages, search, …) → return to the
 *    `journal` start destination.
 *  - `journal` → not handled (`false`): true root, the caller exits.
 */
export function navigationBackHandler(): boolean {
  const nav = useNavigationStore.getState()
  if (nav.currentView === 'page-editor') {
    const tabsState = useTabsStore.getState()
    const activeTab = tabsState.tabs[tabsState.activeTabIndex]
    const pageStack = activeTab?.pageStack ?? []
    if (pageStack.length > 0) {
      tabsState.goBack()
      return true
    }
    nav.setView('journal')
    return true
  }
  if (nav.currentView !== 'journal') {
    nav.setView('journal')
    return true
  }
  return false
}
