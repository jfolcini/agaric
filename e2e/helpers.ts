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

test.beforeEach(async ({ page }) => {
  // Best-effort: the page may or may not have navigated yet. When it has,
  // this re-seeds the mock. When it hasn't, the optional chain no-ops.
  await page.evaluate(() => window.__resetTauriMock__?.()).catch(() => {})
})

export { expect }

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

/** Click a block to enter edit mode and wait for the TipTap editor. */
export async function focusBlock(page: Page, index = 0) {
  await page.locator('[data-testid="block-static"]').nth(index).click()
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.focus()
  return editor
}

/** Save the current block by pressing Enter (flush content → close editor → static render). */
export async function saveBlock(page: Page) {
  await page.keyboard.press('Enter')
  // Wait for the editor to disappear and static block to re-render
  await expect(
    page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
  ).not.toBeVisible()
}

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
  await page.waitForTimeout(350)

  // Move vertically to target in small increments
  const moveSteps = 20
  for (let i = 1; i <= moveSteps; i++) {
    const x = sx + (tx - sx) * (i / moveSteps)
    const y = sy + (ty - sy) * (i / moveSteps)
    await page.mouse.move(x, y)
    if (i % 5 === 0) await page.waitForTimeout(50)
  }

  // Pause for dnd-kit to process the over state, then drop
  await page.waitForTimeout(150)
  await page.mouse.up()
}
