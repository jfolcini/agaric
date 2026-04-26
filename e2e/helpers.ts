import { test as baseTest, expect, type Locator, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Custom `test` export with a global mock-state reset baked in (TEST-1a).
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
// Console-error watcher (TEST-4).
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
  // Vite dev server does not serve `/favicon.ico`; chromium logs a 404 on
  // every page load. Same filter as the original `smoke.spec.ts` listener.
  /favicon/,
  // Generic "Failed to load resource: the server responded with a status of
  // 404 (Not Found)" wrapper that accompanies the favicon 404 above.
  /Failed to load resource/,
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
// Portal-scoped locator helpers (TEST-1b).
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
// query that targets content inside a Radix overlay. See TEST-1b in
// REVIEW-LATER.md for the full rationale.
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
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
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
        (!el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')
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
 * `[contenteditable]` is therefore wrong and the pre-TEST-1f helper was
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

// dnd-kit PointerSensor activation delay; do not lower without checking PointerSensor config
const DND_ACTIVATION_DELAY_MS = 350

/**
 * Drag one element to another using manual pointer events.
 *
 * Playwright's built-in `dragTo()` doesn't work with dnd-kit because the
 * PointerSensor requires a delay (≥ 250 ms) with a tolerance (≤ 5 px)
 * before it activates a drag. This helper reproduces that sequence:
 *   1. Move to the source center and press down.
 *   2. Hold still for the activation delay.
 *   3. Move to the target in small increments (vertical only to avoid
 *      dnd-kit interpreting horizontal offset as indent/dedent).
 *   4. Pause for the "over" state, then release.
 */
export async function dragBlock(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()

  if (!sourceBox || !targetBox)
    throw new Error('Could not get bounding boxes for drag source/target')

  const sx = sourceBox.x + sourceBox.width / 2
  const sy = sourceBox.y + sourceBox.height / 2
  // Keep same X to avoid horizontal offset (which dnd-kit interprets as indent/dedent)
  const tx = sx
  const ty = targetBox.y + targetBox.height / 2

  // pointerdown on the drag handle
  await page.mouse.move(sx, sy)
  await page.mouse.down()

  // Hold still for the delay activation constraint (250 ms delay, 5 px tolerance)
  await page.waitForTimeout(DND_ACTIVATION_DELAY_MS)

  // Move vertically to target in small increments
  const moveSteps = 20
  for (let i = 1; i <= moveSteps; i++) {
    const x = sx + (tx - sx) * (i / moveSteps)
    const y = sy + (ty - sy) * (i / moveSteps)
    await page.mouse.move(x, y)
    // Inter-step pause for HitTest update — lets dnd-kit's collision detection
    // observe the new pointer position before the next move event arrives
    if (i % 5 === 0) await page.waitForTimeout(50)
  }

  // Post-drop ProseMirror DOM settle — pause for dnd-kit to process the final
  // "over" state and let any pending DOM updates flush before the mouse-up
  await page.waitForTimeout(150)
  await page.mouse.up()
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
    ({ from, to }) => {
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
        const last = textNodes[textNodes.length - 1] as Text
        return [last, last.length]
      }
      const [startNode, startOff] = locate(from)
      const [endNode, endOff] = locate(to)
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
