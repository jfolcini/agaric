// ---------------------------------------------------------------------------
// Shared helpers for the real-backend WebdriverIO round-trip specs (#3085).
//
// These drive the REAL Agaric binary in a WebKitWebView via tauri-driver — the
// genuine Rust backend over real Tauri IPC, NOT the JS mock the Playwright
// `e2e/` suite uses. The specs that import these helpers target exactly the
// bug class the #3082 umbrella wants dead: mock-vs-real drift and "durable
// state vanishes after navigation/reload". Factoring the app-ready wait, the
// view navigation, and the block-create flow here keeps the weekly job's
// failure output legible (one named helper per interaction).
//
// `browser`, `$`, and `expect` are provided as GLOBALS by @wdio/globals at
// runtime (typed via `@wdio/globals/types` in tsconfig.wdio.json), exactly as
// the pioneering `smoke.e2e.ts` relies on them — so no imports are needed and
// this file stays a drop-in peer of that proven spec.
//
// Selector policy (all statically validated against component source):
//   - `[data-slot="sidebar"]`               ui/sidebar.tsx (the nav shell)
//   - `aria/<Label>` scoped to the sidebar  AppSidebar.tsx renderNavItem
//     (accessible name === the i18n nav label: Journal / Tags / Pages /
//     Settings) — scoping to the sidebar avoids the like-named QuickAccessBar
//     chip, mirroring smoke.e2e.ts.
//   - `aria-current="page"`                 AppSidebar.tsx renderNavItem sets
//     it on the active nav button (spread onto the DOM <button> by
//     SidebarMenuButton `{...props}`). This is a VIEW-AGNOSTIC readiness
//     signal: after a nav click the target button flips to `page`, proving the
//     view actually switched — no per-view anchor or timing race required.
//   - `button*=Add block`                   JournalPage "Add block" action
//     (`agenda.day.addBlock`), the same selector smoke.e2e.ts committed to.
//   - `[data-testid="block-editor"]`        the roving TipTap editor box.
//   - `[data-testid="block-static"]`        a committed (non-focused) block row
//     (StaticBlock; carries `data-block-id`).
// ---------------------------------------------------------------------------

// Boot of a real WebKitWebView + first live-backend IPC round-trip is slower
// than a headless-chrome mock, so keep every wait generous and never race.
export const APP_READY_TIMEOUT = 60_000
export const NAV_TIMEOUT = 30_000
export const ACTION_TIMEOUT = 30_000

/** Primary nav destinations addressable by their accessible name. */
export type NavLabel = 'Journal' | 'Tags' | 'Pages' | 'Settings'

/**
 * Wait until the app has booted against the real backend: the desktop sidebar
 * has mounted (BootGate resolved) and the Journal nav is displayed. The default
 * 1024px window is above the md breakpoint, so the sidebar is visible.
 */
export async function waitForAppReady(): Promise<void> {
  const sidebar = $('[data-slot="sidebar"]')
  await sidebar.waitForExist({ timeout: APP_READY_TIMEOUT })
  const journalNav = sidebar.$('aria/Journal')
  await journalNav.waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/**
 * Click a primary sidebar nav destination and wait for the view to actually
 * switch. Readiness is confirmed by the clicked button gaining
 * `aria-current="page"` (AppSidebar.tsx renderNavItem), which is set only once
 * `currentView === item.id` — a robust, view-agnostic signal that survives the
 * async reprojection the real backend performs on every view change.
 *
 * The nav is re-queried inside the sidebar on each call so the helper needs no
 * caller-passed element; the sidebar `[data-slot="sidebar"]` node is stable
 * (React keys the nav buttons by id, so `aria-current` updates in place).
 */
export async function navigateTo(label: NavLabel): Promise<void> {
  const sidebar = $('[data-slot="sidebar"]')
  const nav = sidebar.$(`aria/${label}`)
  await nav.waitForClickable({ timeout: NAV_TIMEOUT })
  await nav.click()
  await browser.waitUntil(async () => (await nav.getAttribute('aria-current')) === 'page', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `sidebar nav "${label}" never became the active view (aria-current="page")`,
  })
}

/**
 * Locate a committed block row by a substring of its text. A non-focused block
 * renders as StaticBlock (`data-testid="block-static"`); `*=` matches its text.
 * Returned lazily (chainable) so callers can `waitForDisplayed` /
 * `getAttribute('data-block-id')` / assert on it as needed.
 */
export function blockStaticByMarker(marker: string) {
  return $(`[data-testid="block-static"]*=${marker}`)
}

/**
 * Create a block in the Journal daily view carrying a unique marker, and wait
 * for it to commit and render as a StaticBlock. Reuses the exact interaction
 * smoke.e2e.ts proved: the "Add block" action mounts the roving TipTap editor
 * (`block-editor` contenteditable); typing + Enter flushes the create op
 * through the live backend and moves the roving editor to a fresh sibling;
 * Escape blurs out of that new editor. The final `waitForDisplayed` proves the
 * real backend accepted the op and the frontend reprojected it.
 *
 * Assumes the Journal view is active (call `navigateTo('Journal')` first if a
 * prior step moved away).
 */
export async function addBlockWithMarker(marker: string): Promise<void> {
  const addBlock = $('button*=Add block')
  await addBlock.waitForClickable({ timeout: ACTION_TIMEOUT })
  await addBlock.click()

  const editor = $('[data-testid="block-editor"] [contenteditable="true"]')
  await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await editor.click()
  // Type char-by-char (browser.keys array) so no IME/paste path is involved.
  await browser.keys(marker.split(''))
  await browser.keys(['Enter'])
  await browser.keys(['Escape'])

  const committed = blockStaticByMarker(marker)
  await committed.waitForDisplayed({ timeout: ACTION_TIMEOUT })
}
