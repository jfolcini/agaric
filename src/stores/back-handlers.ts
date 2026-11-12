/**
 * Built-in Android back-chain steps (#716): overlay-close and in-app
 * navigation. Registered by `useAndroidBackButton` at
 * `BACK_PRIORITY_OVERLAY` / `BACK_PRIORITY_NAVIGATION`; the middle band
 * (`BACK_PRIORITY_ZOOM`) is registered dynamically by `useBlockZoom`
 * while a BlockTree is zoomed.
 */

import { useNavigationStore } from '@/stores/navigation'
import { canNavigateBack, navigateBack, recordNextAsReplace } from '@/stores/navigation-history'
import { exitViewForTab, useTabsStore } from '@/stores/tabs'

/**
 * Open overlays that swallow a back press. Interactive roles only:
 * `data-state="open"` alone also matches collapsibles and tooltips.
 */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(', ')

/**
 * Step 1 — overlay close: with an overlay open, dispatch a synthetic Escape
 * `keydown` on the focused element and consume the press, reusing the desktop
 * dismiss paths: Radix closes its topmost layer, React `onKeyDown` handlers
 * run, and `useAppKeyboardShortcuts` closes non-Radix overlays. Dispatched on
 * `activeElement`, not `document.body`, because React delegates events at
 * root and portal containers, which an event on body never reaches; inner
 * handlers such as the palette's action menu would miss it and Back would do
 * nothing.
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
 * Step 3 — in-app navigation. Walks the header's Back history first, so the
 * gesture and the ← button agree. With no history (a fresh launch) it
 * collapses toward the start destination: in the page editor, pop the tab's
 * stack (`goBack`), or with an empty stack go to `exitViewForTab`, the rule
 * `goBack` uses (#4287); from any other view go to `journal`; on `journal`,
 * decline so the app exits. A fallback step replaces its history entry rather
 * than pushing one, and the exit view is never the editor, so the chain ends.
 */
export function navigationBackHandler(): boolean {
  if (canNavigateBack()) {
    navigateBack()
    return true
  }
  const nav = useNavigationStore.getState()
  if (nav.currentView === 'journal') return false
  recordNextAsReplace()
  if (nav.currentView === 'page-editor') {
    const tabsState = useTabsStore.getState()
    const activeTab = tabsState.tabs[tabsState.activeTabIndex]
    const pageStack = activeTab?.pageStack ?? []
    if (pageStack.length > 0) {
      tabsState.goBack()
      return true
    }
    nav.setView(exitViewForTab(activeTab))
    return true
  }
  nav.setView('journal')
  return true
}
