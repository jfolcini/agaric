import { test as baseTest, expect, type Locator, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Custom `test` export with a global mock-state reset baked in.
//
// Every spec file should `import { expect, test } from './helpers'` instead
// of `@playwright/test`. The `beforeEach` below issues a best-effort reset
// of the Tauri mock's module-scoped in-memory state (blocks, tags, op log,
// error-injection map, attachments, property defs, aliases) so that one
// test's mutations cannot bleed into the next.
//
// Optional chaining on the window lookup: if the page hasn't been navigated
// yet (first test that calls `page.goto` inside its body), the hook is a
// no-op — the subsequent page load runs `setupMock()` which seeds fresh.
// For subsequent tests within the same worker/context, the mock module is
// already loaded, so the reset actively wipes and re-seeds state.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __resetTauriMock__?: () => void
  }
}

export const test = baseTest

// ---------------------------------------------------------------------------
// Console-error watcher.
//
// Every spec gets a `page.on('console', ...)` + `page.on('pageerror', ...)`
// listener registered automatically by the global `beforeEach` below, and
// the global `afterEach` asserts no errors leaked through. The smoke spec
// pioneered the pattern; this lifts it to every spec for free so backend
// failures, IPC handler crashes, error-boundary fall-throughs, and
// unhandled rejections cannot pass silently in any E2E suite.
//
// Per-spec opt-out for tests that *deliberately* exercise error paths
// (e.g. `error-scenarios.spec.ts` injects backend failures via the mock):
//   - `getConsoleErrors(page)` returns the live captured array. The test
//     may inspect it and then call `clearConsoleErrors(page)` before the
//     global afterEach runs so the deliberate noise does not fail the
//     suite.
//
// Whitelist patterns are deliberately conservative — favicon noise only.
// New entries require a comment with a rationale.
// ---------------------------------------------------------------------------

/**
 * Patterns the watcher silently drops. Each entry MUST cite *why* the noise
 * is benign so the next session can re-evaluate. Adding to this list is the
 * exception; fixing the source is the rule.
 */
const IGNORED_CONSOLE_ERROR_PATTERNS: RegExp[] = [
  // Vite dev server doesn't serve `/favicon.ico`; chromium logs the exact
  // 404 on every page load. We match the literal chromium message so any
  // OTHER 4xx/5xx (broken `<img src>`, missing fonts, dropped attachment
  // URLs, mock 404s, backend 4xx in production) surfaces through the
  // afterEach `expectNoConsoleErrors` gate as a real test failure.
  /Failed to load resource:.*\/favicon\.ico/,
]

const consoleErrorsByPage = new WeakMap<Page, string[]>()

function isIgnoredConsoleError(text: string): boolean {
  return IGNORED_CONSOLE_ERROR_PATTERNS.some((re) => re.test(text))
}

/**
 * Register the per-page console + pageerror listeners. Called automatically
 * by the global `beforeEach`; safe to call again (no-ops on the second call
 * for the same page).
 *
 * Listeners are attached *before* any `page.goto()` in the test body so
 * pre-load errors (e.g. early script-tag failures) are captured.
 */
export function registerConsoleErrorWatcher(page: Page): void {
  if (consoleErrorsByPage.has(page)) return
  const errors: string[] = []
  consoleErrorsByPage.set(page, errors)

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (isIgnoredConsoleError(text)) return
    errors.push(text)
  })

  page.on('pageerror', (err) => {
    const text = `pageerror: ${err.message}`
    if (isIgnoredConsoleError(text)) return
    errors.push(text)
  })
}

/**
 * Get the live array of console errors captured for this page. Mutating
 * the returned array (e.g. `.length = 0`) clears the buffer for the
 * global afterEach assertion.
 */
export function getConsoleErrors(page: Page): string[] {
  return consoleErrorsByPage.get(page) ?? []
}

/** Clear the captured-errors buffer for this page. */
export function clearConsoleErrors(page: Page): void {
  const errors = consoleErrorsByPage.get(page)
  if (errors) errors.length = 0
}

/**
 * Assert no unexpected console errors were captured. Invoked automatically
 * by the global afterEach below.
 */
export function expectNoConsoleErrors(page: Page): void {
  const errors = consoleErrorsByPage.get(page) ?? []
  expect(
    errors,
    `Unexpected console errors captured during test:\n  - ${errors.join('\n  - ')}`,
  ).toEqual([])
}

test.beforeEach(async ({ page }) => {
  // Register the console-error watcher BEFORE any page activity so the
  // mock-reset evaluate (and any subsequent goto in the test body) are
  // covered.
  registerConsoleErrorWatcher(page)
  // Best-effort: the page may or may not have navigated yet. When it has,
  // this re-seeds the mock. When it hasn't, the optional chain no-ops.
  await page.evaluate(() => window.__resetTauriMock__?.()).catch(() => {})
})

test.afterEach(({ page }) => {
  expectNoConsoleErrors(page)
})

export { expect }

// ---------------------------------------------------------------------------
// Portal-scoped locator helpers.
//
// Radix UI primitives render Dialog / AlertDialog / Popover / Sheet / Tooltip
// content into `document.body` via portals. When a test closes an overlay,
// React may keep the DOM node around for a commit or two (e.g. during the
// unmount animation), and the next test can briefly see both the stale and
// the fresh portal container at the same time. Root-level queries like
// `page.getByRole('button', { name: 'Apply' })` then either:
//   - match two elements → `toBeVisible()` throws "resolved to N elements"
//   - match the stale one first → the assertion hits the wrong subtree.
//
// The fix is test-side scoping: query WITHIN the active portal container,
// and pick `.last()` so the most-recent portal wins when two coexist briefly.
//
// Prefer these helpers over root `page.getByRole` / `page.getByText` for any
// Query that targets content inside a Radix overlay.
// ---------------------------------------------------------------------------

/** Active Radix Dialog content (data-slot="dialog-content"). */
export function activeDialog(page: Page): Locator {
  return page.locator('[data-slot="dialog-content"]').last()
}

/** Active Radix AlertDialog content (data-slot="alert-dialog-content"). */
export function activeAlertDialog(page: Page): Locator {
  return page.locator('[data-slot="alert-dialog-content"]').last()
}

/** Active Radix Popover content (data-slot="popover-content"). */
export function activePopover(page: Page): Locator {
  return page.locator('[data-slot="popover-content"]').last()
}

/**
 * Open the Pages-view "Add filter" popover and return its content locator,
 * guaranteeing it is visible before the caller interacts with it.
 *
 * Why a helper: a bare `getByRole('Add filter').click()` is racy under the
 * pre-push load — the click can land a frame before Radix wires the trigger,
 * so the popover never opens and the *next* interaction times out with a
 * misleading "element not found" deep inside the popover. Here we click,
 * wait for the popover, and (only if it never appeared) click once more.
 * The re-click fires solely on the not-opened path, so it can't toggle an
 * already-open popover shut.
 */
export async function openAddFilter(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Add filter' })
  const pop = activePopover(page)
  await trigger.click()
  try {
    await expect(pop).toBeVisible({ timeout: 5000 })
  } catch {
    await trigger.click()
    await expect(pop).toBeVisible({ timeout: 10000 })
  }
  return pop
}

/** Active Radix Sheet content (data-slot="sheet-content"). */
export function activeSheet(page: Page): Locator {
  return page.locator('[data-slot="sheet-content"]').last()
}

/**
 * Active `role="dialog"` node. Matches Radix Dialog / Sheet / AlertDialog
 * (all apply role="dialog" internally) as well as hand-rolled pickers such
 * as `TemplatePicker` that set the role manually. Use `activeDialog` /
 * `activeSheet` when a tighter data-slot match is available.
 */
export function activeRoleDialog(page: Page): Locator {
  return page.locator('[role="dialog"]').last()
}

/** Active custom block-context menu (role="menu"). */
export function activeMenu(page: Page): Locator {
  return page.locator('[role="menu"]').last()
}

/**
 * Delete a block through the right-click / long-press context menu.
 *
 * The hover "Delete block" gutter button was removed (2026-06-20); Delete now
 * lives only in `BlockContextMenu`. `block` should be a `sortable-block`
 * locator. Right-clicks to open the menu, then clicks its "Delete" item.
 */
export async function deleteBlockViaContextMenu(page: Page, block: Locator): Promise<void> {
  await block.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Block actions' }).last()
  // Substring (non-exact) match: the menu item's accessible name carries its
  // shortcut hint ("Delete … (when empty)"), so an exact "Delete" matches
  // nothing. This helper is only used single-block (no active selection), so
  // "Delete" is unambiguous — the bulk "Delete N selected" label never renders.
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
}

/** Active TipTap suggestion popup container (ReactRenderer portal). */
export function activeSuggestionPopup(page: Page): Locator {
  return page.locator('[data-testid="suggestion-popup"]').last()
}

/** Active TipTap suggestion list (role="listbox" child of the popup). */
export function activeSuggestionList(page: Page): Locator {
  return page.locator('[data-testid="suggestion-list"]').last()
}

/** Wait for the app to fully boot (BootGate resolved, sidebar visible). */
export async function waitForBoot(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
}

/** Navigate to the page editor for a given page title. */
export async function openPage(page: Page, title: string) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/**
 * Navigate to the page editor for a given page title at a MOBILE / coarse-
 * pointer viewport (iPhone-class, ≤ md breakpoint).
 *
 * The desktop sidebar (`[data-slot="sidebar"]`) is `hidden` below the `md`
 * breakpoint, so `openPage`'s "click the Pages button, then the page title"
 * path is unreachable on a 390px touch context — its `getByText(title).click()`
 * fails with "element is not visible". The mobile chrome instead exposes the
 * unified search sheet (`search-sheet-trigger`); its all-pages segment mounts
 * the command palette, whose page-header result row calls `navigateToPage`
 * exactly like the desktop sidebar click does.
 *
 * Flow: tap the sheet trigger → force the all-pages (palette) segment on (the
 * sheet defaults to in-page on page-style views like Journal) → type the page
 * title → click the matching page-header row → assert the editor's
 * `[aria-label="Page title"]` is visible. The seeded "Getting Started" /
 * "Quick Notes" pages are reachable this way at 390px.
 */
export async function openPageMobile(page: Page, title: string) {
  const trigger = page.getByTestId('search-sheet-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()

  const sheet = page.getByTestId('search-sheet')
  await expect(sheet).toBeVisible()

  // Force the all-pages (palette) segment — page-style views (Journal) default
  // to in-page, which has no cross-page search. The palette is where page-title
  // navigation lives.
  const allPagesSegment = page.getByTestId('search-sheet-segment-all-pages')
  if ((await allPagesSegment.getAttribute('data-state')) !== 'on') {
    await allPagesSegment.click()
    await expect(allPagesSegment).toHaveAttribute('data-state', 'on')
  }

  const paletteInput = page.getByTestId('command-palette-input')
  await expect(paletteInput).toBeVisible()
  await paletteInput.fill(title)

  // The page-header result row (`palette-page-header-<id>`) carries the page
  // title; click the one whose accessible text matches. Navigating closes the
  // sheet and mounts the page editor.
  const pageRow = page
    .locator('[data-testid^="palette-page-header-"]')
    .filter({ hasText: title })
    .first()
  await expect(pageRow).toBeVisible()
  await pageRow.click()

  await expect(sheet).toHaveCount(0)
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()

  // The page-title header mounts a beat before the BlockTree finishes its
  // async fetch+render of the child rows. Under CI parallel load (many specs
  // sharing one Vite dev server) that gap widens, so a caller that immediately
  // queries a block — e.g. `sortable-block` `.nth(2)` — can race an empty list
  // and time out. Wait for the first content row to render so navigation has
  // truly settled before we return. (`first()` is enough; any seeded page that
  // this helper navigates to has at least one block.)
  await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
}

/**
 * Wait until the BlockTree has FULLY settled at `expectedRows` hydrated content
 * rows — the count must REACH `expectedRows` AND then hold STILL across
 * consecutive samples (with no loading skeleton present) before we return.
 *
 * Why this exists (#968): `BlockTree` renders a loading skeleton with ZERO
 * `sortable-block` rows whenever the per-page store's `loading` flag is true
 * (`store.load()` flips `loading: true` → fetch → `loading: false`). The
 * mobile navigation path can fire a SECOND `load()` shortly AFTER the first
 * content row paints (a re-mount of `PageEditor`/`BlockTree` as the search
 * sheet tears down and the tab settles, giving a fresh store whose initial
 * `loading: true` blanks the tree again). Under the GH runner's parallel/
 * headless contention on one shared Vite dev server that second blank window
 * widens, so a test that reads `sortable-block.nth(2)` right after
 * `openPageMobile` (which only awaits the FIRST row) can capture the tree
 * during the transient empty render and the drag lands on nothing — the #968
 * "rows render then vanish mid-test" flake.
 *
 * `expect.poll` auto-waits and retries, and the `block-tree-loading` skeleton
 * absence check ensures we are not sampling a count of 0 that merely hasn't
 * repainted yet. Requiring the count to repeat (`stableSamples` identical
 * reads) guards against catching a value mid-transition.
 *
 * On `expectedRows`: this is the number of HYDRATED `sortable-block` rows the
 * caller needs, NOT the page's seed-child count. `SortableBlockWrapper`
 * virtualizes the tree — off-screen blocks render as empty `block-placeholder`
 * <li>s and only promote to `sortable-block` rows once on-screen — so a 5-child
 * page on a phone viewport hydrates only the rows that fit (e.g. 3). The caller
 * passes that on-screen count.
 *
 * Why this changed (#1045): the helper previously asserted a bare
 * `>= expectedRows` MINIMUM on a 15000ms budget. Under CI parallelism the rows
 * hydrate incrementally and the resource-starved GH runner was observed at only
 * 2 of the expected 3 still climbing when the 15s budget expired — a partial
 * paint that the `>=` check on a too-short budget could neither satisfy nor
 * outlast. We now (a) keep polling until the count REACHES `expectedRows`
 * (`last < expectedRows` returns the partial count, which fails the assertion
 * and keeps the poll going), then require it to hold steady, so an incremental
 * 1→2→3 paint settles to 3 before returning; and (b) raise the timeout to
 * 30000ms — twice the old 15s budget, grounded in the CI observation of the
 * count still climbing at 15s — with longer polling intervals so we keep
 * retrying across the full budget instead of burning it in the first seconds.
 * Callers must allow a per-test timeout above 30s for this budget to be usable.
 */
export async function waitForStableBlockRows(page: Page, expectedRows = 1): Promise<void> {
  const rows = page.locator('[data-testid="sortable-block"]')
  const skeleton = page.locator('.block-tree-loading')
  const stableSamples = 3

  await expect
    .poll(
      async () => {
        // A visible loading skeleton means the store is mid-(re)load → the row
        // list is (or is about to be) empty; treat as not-yet-stable.
        if ((await skeleton.count()) > 0) return -1
        let last = await rows.count()
        // Not yet fully painted: keep polling until every expected row has
        // hydrated. Returning the partial count fails the assertion below and
        // lets `expect.poll` retry across the full budget.
        if (last < expectedRows) return last
        // Re-sample: the count must hold across consecutive reads, otherwise we
        // may be observing a value that is about to be blanked by a pending
        // `load()` or that is still climbing as more rows hydrate. A short
        // settle between reads lets a queued re-render commit.
        for (let i = 0; i < stableSamples; i++) {
          await page.waitForTimeout(60)
          if ((await skeleton.count()) > 0) return -1
          const next = await rows.count()
          if (next !== last) {
            last = next
            i = -1 // restart the stability window on any change
          }
        }
        return last
      },
      { timeout: 30000, intervals: [200, 400, 800, 1000] },
    )
    .toBeGreaterThanOrEqual(expectedRows)

  // Belt-and-braces: the last expected row must still be attached + visible at
  // the moment this helper returns.
  await expect(rows.nth(expectedRows - 1)).toBeVisible()
}

// ---------------------------------------------------------------------------
// Search-view helpers.
//
// `openSearchView` boots the app and navigates to the find-in-files search
// view (the `SearchPanel`), waiting for the header label so the panel has
// mounted before the caller interacts with it.
//
// `installIpcRecorder` / `getInvokeCalls` let a spec assert the *IPC payload*
// the UI sends. The Tauri mock installs `window.__TAURI_INTERNALS__.invoke`
// at boot (see `@tauri-apps/api/mocks` + `tauri-mock/index.ts`). We wrap that
// live function with a recorder that pushes `{ cmd, args }` onto a window
// array, then delegates to the original so the mock still answers. This is
// purely test-side — no production source is touched — and is the only way to
// observe toggle flags / filter params on the web+mock harness (the mock's
// `search_blocks` handler folds on content and ignores the filter struct).
// ---------------------------------------------------------------------------

/** Boot the app and open the find-in-files Search view (SearchPanel). */
export async function openSearchView(page: Page): Promise<Locator> {
  await waitForBoot(page)
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Search', exact: true })
    .click()
  await expect(page.getByTestId('header-label')).toContainText('Search')
  const input = page.getByPlaceholder('Search blocks...')
  await expect(input).toBeVisible()
  return input
}

declare global {
  interface Window {
    __ipcCalls__?: Array<{ cmd: string; args: unknown }>
  }
}

/**
 * Wrap the live Tauri-mock `invoke` with a recorder. Must be called AFTER the
 * app has booted (the mock installs `invoke` during `setupMock()` on load).
 * Idempotent: a second call resets the buffer without double-wrapping.
 */
export async function installIpcRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> })
      .__TAURI_INTERNALS__
    if (!internals) return
    window.__ipcCalls__ = []
    const tagged = internals['invoke'] as { __recorderWrapped__?: boolean } | undefined
    if (tagged?.__recorderWrapped__) return
    const original = internals['invoke'] as (cmd: string, args: unknown, opts?: unknown) => unknown
    const wrapped = (cmd: string, args: unknown, opts?: unknown) => {
      window.__ipcCalls__?.push({ cmd, args })
      return original(cmd, args, opts)
    }
    ;(wrapped as { __recorderWrapped__?: boolean }).__recorderWrapped__ = true
    internals['invoke'] = wrapped
  })
}

/** Return the recorded `{ cmd, args }` calls for a given command name. */
export function getInvokeCalls(page: Page, cmd: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (name) =>
      (window.__ipcCalls__ ?? [])
        .filter((c) => c.cmd === name)
        .map((c) => c.args as Record<string, unknown>),
    cmd,
  )
}

/** Clear the IPC recorder buffer (e.g. between assertions). */
export async function clearInvokeCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__ipcCalls__ = []
  })
}

/**
 * Navigate away and back to force `BlockTree` to re-fetch from the mock backend.
 *
 * Used in undo/redo flows. Block-level undo (`useUndoShortcuts`) calls
 * `undoPageOp` against the mock, which mutates the mock's in-memory state,
 * but the frontend's `BlockTree` doesn't auto-refresh on undo. Navigating to
 * Status and back triggers a full re-render with the post-undo state.
 *
 * `exact: true` on the Status button is load-bearing: a "Toggle template
 * status" tooltip trigger also matches the accessible name "Status" by
 * substring otherwise, and Playwright strict-mode then fails with two
 * candidates.
 */
export async function reopenPage(page: Page, title: string) {
  await page.getByRole('button', { name: 'Status', exact: true }).click()
  await expect(page.locator('[data-testid="header-label"]')).toContainText('Status')
  await openPage(page, title)
}

/** Click a block to enter edit mode and wait for the TipTap editor. */
export async function focusBlock(page: Page, index = 0) {
  await page.locator('[data-testid="block-static"]').nth(index).click()
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.focus()
  return editor
}

/**
 * Click the block-static element with the given block id and wait for the
 * TipTap editor to mount. Use this instead of `focusBlock(page, n)` when:
 *
 *   - Another block may already be in editor mode (the bare `block-static`
 *     locator collapses to N-1 elements while one block is focused, so
 *     `nth(n)` no longer maps to the n-th sibling in document order).
 *   - The test needs to focus a specific block by its ULID rather than by
 *     visual position.
 *
 * Callers that need to switch focus from one already-focused block to
 * another should send a `Escape` keystroke first to drain the previous
 * editor's blur path before clicking the new target — clicking a
 * block-static directly while another block holds the roving editor
 * triggers a blur+focus race that intermittently leaves no editor mounted.
 */
export async function focusBlockById(page: Page, blockId: string) {
  await page.locator(`[data-testid="block-static"][data-block-id="${blockId}"]`).click()
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.focus()
  return editor
}

/**
 * Escape any `contentEditable` / input focus so the next Ctrl+Z is handled
 * by `useUndoShortcuts` (which skips `contentEditable` targets) instead of
 * ProseMirror's in-editor undo.
 *
 * Used to disambiguate the two-tier undo model in E2E flows:
 *   - In-editor: ProseMirror undoes within the focused block.
 *   - Page-level: `useUndoShortcuts` reverses the last block-level op.
 *
 * Presses Escape, then programmatically blurs the active element (so focus
 * lands on `document.body`), and finally polls until the active element is
 * `document.body` or any non-editable / non-input element.
 */
export async function blurEditors(page: Page) {
  await page.keyboard.press('Escape')
  // Programmatically blur the active element so focus is on document.body
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
  // Wait until no contenteditable or input is focused
  await page.waitForFunction(
    () => {
      const el = document.activeElement
      return (
        !el ||
        el === document.body ||
        (!(el as HTMLElement).isContentEditable &&
          el.tagName !== 'INPUT' &&
          el.tagName !== 'TEXTAREA')
      )
    },
    { timeout: 2000 },
  )
}

/**
 * Save the current block by pressing Enter and wait for the editor to commit.
 *
 * The product's Enter handler flushes the currently-edited block and moves
 * the roving editor to a newly-created sibling below (see `handleEnterSave`
 * in `useBlockKeyboardHandlers`). This means there is ALWAYS an editor
 * visible after a save — just on the new sibling, not on the block that
 * was being edited. The old `not.toBeVisible()` check for any
 * `[contenteditable]` is therefore wrong and the pre- helper was
 * effectively waiting for a timeout on every call.
 *
 * We identify the specific block that was being edited via its
 * `data-block-id`, press Enter, and then wait for that exact block to
 * show its `data-testid="block-static"` render — i.e. the editor has left
 * that block, regardless of whether it re-mounted somewhere else.
 *
 * Falls back to a short fixed wait (frame flush) if we can't locate an
 * editing block (e.g. caller already blurred the editor, or tests that
 * don't use a TipTap editor at all).
 */
export async function saveBlock(page: Page) {
  const editingBlock = page
    .locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
    .first()
  const blockId = await editingBlock.getAttribute('data-block-id').catch(() => null)
  await page.keyboard.press('Enter')
  if (blockId) {
    await expect(
      page.locator(
        `[data-testid="sortable-block"][data-block-id="${blockId}"] [data-testid="block-static"]`,
      ),
    ).toBeVisible()
  } else {
    // Editor wasn't identifiable pre-save (e.g. already blurred). Give the
    // DOM one microtask to settle and return — callers typically assert
    // their own post-save state immediately after.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
  }
}

// ---------------------------------------------------------------------------
// dnd-kit drag helpers — split by sensor (#926 f6).
//
// The product wires ONE @dnd-kit PointerSensor whose activation constraint is
// chosen at runtime by pointer coarseness (`src/hooks/useBlockDnD.ts`):
//
//   - FINE pointer (mouse / desktop): `{ distance: 8 }` — the drag activates as
//     soon as the pointer travels 8 px. There is NO time delay, so the desktop
//     helper must NOT burn an artificial hold (the old single helper paid the
//     touch sensor's 250 ms on every desktop drag for no reason).
//   - COARSE pointer (touch / narrow): `{ delay: 250, tolerance: 5 }` — a
//     press-and-hold so a drag doesn't fight scrolling. The touch helper holds
//     still past 250 ms BEFORE moving so the sensor latches the drag.
//
// Both paths still drive @dnd-kit through Playwright's pointer stream
// (`page.mouse`), which under a `hasTouch` context emits the pointer events the
// PointerSensor listens to. (@dnd-kit does NOT consume raw `touchstart` — those
// belong to the product's own long-press / swipe React handlers, exercised via
// `touchGesture` below, not these drag helpers.)
// ---------------------------------------------------------------------------

// Coarse-pointer PointerSensor delay (250 ms) + headroom; the touch drag must
// out-wait it before moving. Do not lower without checking the sensor config.
const DND_TOUCH_HOLD_MS = 350

interface PointerDragOptions {
  /** Hold still after pointerdown before moving (touch sensor delay). */
  holdMs?: number
  /** Final horizontal pixel delta from source X (indent/dedent projection). */
  offsetX?: number
}

/**
 * Shared pointer-drag primitive backing both the desktop and touch helpers.
 *
 * Sequence: move to source center → pointerdown → (optional hold) → step
 * vertically to the target row → (optional) step horizontally for the
 * indent/dedent offset → settle → pointerup. Small inter-step pauses let
 * @dnd-kit's collision detection observe each new position.
 */
async function performPointerDrag(
  page: Page,
  source: Locator,
  target: Locator,
  { holdMs = 0, offsetX = 0 }: PointerDragOptions = {},
): Promise<void> {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox)
    throw new Error('Could not get bounding boxes for drag source/target')

  const sx = sourceBox.x + sourceBox.width / 2
  const sy = sourceBox.y + sourceBox.height / 2
  const ty = targetBox.y + targetBox.height / 2

  await page.mouse.move(sx, sy)
  await page.mouse.down()

  // Touch path: hold still past the 250 ms press-and-hold activation delay.
  // Desktop path (holdMs 0): the `{ distance: 8 }` sensor latches on movement
  // alone, so we skip straight to the move.
  if (holdMs > 0) await page.waitForTimeout(holdMs)

  const steps = 20
  // Phase 1 — vertical travel to the target row (no horizontal drift so the
  // projected depth stays put until we deliberately push sideways).
  for (let i = 1; i <= steps; i++) {
    const y = sy + (ty - sy) * (i / steps)
    await page.mouse.move(sx, y)
    if (i % 5 === 0) await page.waitForTimeout(50)
  }

  // Phase 2 — horizontal offset for indent/dedent projection (skipped at 0).
  if (offsetX !== 0) {
    for (let i = 1; i <= steps; i++) {
      const x = sx + offsetX * (i / steps)
      await page.mouse.move(x, ty)
      if (i % 5 === 0) await page.waitForTimeout(50)
    }
  }

  // Settle so @dnd-kit processes the final "over" state before release.
  await page.waitForTimeout(150)
  await page.mouse.up()
}

/**
 * DESKTOP drag (#926 f6) — distance-activated, no artificial hold.
 *
 * Drives the fine-pointer `{ distance: 8 }` sensor. Moves vertically only so
 * @dnd-kit doesn't read a horizontal delta as indent/dedent.
 */
export async function dragBlock(page: Page, source: Locator, target: Locator): Promise<void> {
  await performPointerDrag(page, source, target)
}

/**
 * TOUCH drag (#926 f6) — press-and-hold past the 250 ms coarse-pointer delay,
 * then move. Use under a `hasTouch` / coarse-pointer context (the product
 * picks the press-and-hold sensor there). Vertical-only by default.
 */
export async function dragBlockTouch(page: Page, source: Locator, target: Locator): Promise<void> {
  await performPointerDrag(page, source, target, { holdMs: DND_TOUCH_HOLD_MS })
}

// ---------------------------------------------------------------------------
// Raw TouchEvent dispatch for the product's React touch handlers (#927 / #926).
//
// The block row's long-press → context-menu (`useBlockTouchLongPress`) and
// swipe gestures (`useBlockSwipeActions`) bind to React `onTouchStart` /
// `onTouchMove` / `onTouchEnd`. Those are NOT pointer events — Playwright's
// `page.mouse` / `page.touchscreen` stream won't drive them. We instead build
// real `Touch` + `TouchEvent` objects in the page and dispatch them on the
// target element; React's delegated listener at the document root picks them
// up like a genuine finger. (@dnd-kit's PointerSensor is unaffected — it
// listens for pointer events, so these touch streams don't trip a drag.)
//
// `selector` must resolve to a single element in the page (e.g. a
// `data-testid`/`data-block-id` query). Coordinates are viewport CSS pixels.
// ---------------------------------------------------------------------------

/** Dispatch a single native touch event of `type` at `(x, y)` on `selector`. */
async function dispatchTouch(
  page: Page,
  selector: string,
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ({ selector: sel, type: evType, x: cx, y: cy }) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`dispatchTouch: no element for selector ${sel}`)
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: cx,
        clientY: cy,
        pageX: cx,
        pageY: cy,
      })
      // touchend carries no live `touches`, only `changedTouches`.
      const active = evType === 'touchend' ? [] : [touch]
      const ev = new TouchEvent(evType, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: active,
        targetTouches: active,
        changedTouches: [touch],
      })
      el.dispatchEvent(ev)
    },
    { selector, type, x, y },
  )
}

/**
 * Long-press the center of `selector` and hold past the 400 ms recognition
 * delay (`LONG_PRESS_DELAY`) WITHOUT moving, so `useBlockTouchLongPress` opens
 * the BlockContextMenu. The press point doubles as the menu's anchor.
 *
 * Returns the press coordinates so callers can assert anchor placement.
 */
export async function touchLongPress(
  page: Page,
  selector: string,
  holdMs = 550,
): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`touchLongPress: no bounding box for ${selector}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await dispatchTouch(page, selector, 'touchstart', x, y)
  // Hold still past the 400 ms long-press threshold. No touchmove is sent, so
  // the move-cancel guard never trips.
  await page.waitForTimeout(holdMs)
  await dispatchTouch(page, selector, 'touchend', x, y)
  return { x, y }
}

/**
 * Horizontal swipe across `selector` for `useBlockSwipeActions`.
 *
 * `dx` is the total horizontal travel in CSS px (negative = left / delete,
 * positive = right / indent). Movement is stepped so the hook's running-delta
 * math (reveal vs auto-delete bands) sees a realistic gesture. Vertical drift
 * is kept at 0 so the `VERTICAL_CANCEL_THRESHOLD` guard never fires.
 */
export async function touchSwipe(page: Page, selector: string, dx: number): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`touchSwipe: no bounding box for ${selector}`)
  // Start from the side opposite the swipe direction so the full `dx` stays on-row.
  const startX = dx < 0 ? box.x + box.width * 0.85 : box.x + box.width * 0.15
  const y = box.y + box.height / 2
  await dispatchTouch(page, selector, 'touchstart', startX, y)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await dispatchTouch(page, selector, 'touchmove', startX + (dx * i) / steps, y)
  }
  await dispatchTouch(page, selector, 'touchend', startX + dx, y)
}

/**
 * Drag a block handle to a target row while ALSO applying a horizontal offset
 * at the end — exercises drag-to-indent / drag-to-dedent (dnd-kit interprets
 * the horizontal delta as a depth change via `getProjection`).
 *
 * `offsetX` is the final horizontal pixel delta from the source X. Use a
 * positive value to indent (nest deeper) and a negative value to dedent. To
 * indent a block under its previous sibling WITHOUT reordering, pass the
 * block's own row as `target` so the drag stays "over" itself and only the
 * horizontal offset changes the projected depth.
 */
export async function dragBlockWithOffset(
  page: Page,
  source: Locator,
  target: Locator,
  offsetX: number,
): Promise<void> {
  // Desktop indent/dedent: distance-activated sensor, no artificial hold (#926 f6).
  await performPointerDrag(page, source, target, { offsetX })
}

/**
 * Type a slash command filter inside the currently focused editor.
 * Moves to end of line, types ` /` + waits for the suggestion list to
 * appear, then types the query. Splitting the keystrokes around the
 * visibility assertion avoids a race with the slash extension's
 * auto-execute feature: when exactly one item matches a query of
 * length >= 3, a 200ms timer fires the command and closes the popup
 * (see AUTO_EXEC_DELAY_MS in src/editor/extensions/slash-command.ts).
 * Commands like /todo, /doing, /done resolve to a single match, so
 * asserting visibility AFTER the full query is typed can miss the
 * popup's brief life. Asserting right after `/` (empty query → base
 * list, nothing to auto-execute) is race-free.
 */
export async function typeSlashCommand(page: Page, command: string) {
  await page.keyboard.press('End')
  await page.keyboard.type(' /', { delay: 30 })
  const list = page.locator('[data-testid="suggestion-list"]')
  await expect(list).toBeVisible()
  if (command) {
    await page.keyboard.type(command, { delay: 30 })
  }
  return list
}

/**
 * Select a character range inside the currently-focused TipTap editor
 * by directly manipulating the DOM Selection API, then dispatch a
 * `selectionchange` event so ProseMirror picks up the new range.
 *
 * Prefer this over `Shift+Arrow` keypress loops. Rapid-fire
 * `Shift+Arrow` presses drop increments on React 19 — the scheduler
 * may still be committing the prior selection update when the next
 * keystroke arrives, so the first (or last) press silently no-ops and
 * the resulting selection is off by one or more characters.
 *
 * `from` / `to` are character offsets into the block's text content,
 * counted from the start. Walks the visible text nodes in document
 * order and maps offsets to the correct `(Text, offset)` pair so the
 * helper works for blocks that contain multiple inline spans (e.g.
 * links, inline marks).
 */
export async function selectEditorRange(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ from: fromOff, to: toOff }) => {
      const root = document.querySelector('[data-testid="block-editor"] [contenteditable="true"]')
      if (!root) throw new Error('selectEditorRange: focused editor not found')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      let node: Node | null = walker.nextNode()
      while (node !== null) {
        textNodes.push(node as Text)
        node = walker.nextNode()
      }
      if (textNodes.length === 0) throw new Error('selectEditorRange: no text nodes in editor')
      const locate = (offset: number): [Text, number] => {
        let acc = 0
        for (const t of textNodes) {
          if (acc + t.length >= offset) return [t, offset - acc]
          acc += t.length
        }
        const last = textNodes.at(-1) as Text
        return [last, last.length]
      }
      const [startNode, startOff] = locate(fromOff)
      const [endNode, endOff] = locate(toOff)
      const range = document.createRange()
      range.setStart(startNode, startOff)
      range.setEnd(endNode, endOff)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    },
    { from, to },
  )
}
