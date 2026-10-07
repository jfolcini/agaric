/**
 * E2E — TOUCH block rows: one hold, then the finger decides (#5332 item 10).
 *
 * Runs under an iPhone-class coarse-pointer + touch context so the product
 * takes its touch code paths:
 *   - no leading control lane and no drag grip: the text starts where the row
 *     starts, and a parent's collapse chevron sits at the right end of the row;
 *   - `useBlockDnD` wires a TouchSensor (`{ delay: 400, tolerance: 5 }`) to
 *     the whole row, so a hold-then-move on the row body reorders;
 *   - `useBlockTouchLongPress` shares the hold: a hold released without moving
 *     opens the BlockContextMenu, whose Move Up / Move Down reorder;
 *   - inside the mounted editor a hold is the native text selection.
 *
 * Correctness is asserted on the recorded `move_block` IPC (the deterministic
 * signal — the mock backend is more permissive than production), mirroring the
 * mouse spec. Gestures are real touches through CDP (`dragBlockTouch`,
 * `touchLongPress` in helpers), since the sensor listens to touch events.
 */

import { devices, type Locator } from '@playwright/test'

import {
  clearInvokeCalls,
  dragBlockTouch,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  openPageMobile,
  test,
  touchLongPress,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

const PAGE = 'Getting Started'

// iPhone 13 viewport/touch flags, minus `defaultBrowserType` (which Playwright
// rejects inside a describe-level `test.use`). Mirrors search-sheet-mobile.spec.
const iPhone13 = devices['iPhone 13']

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

async function moveCalls(
  page: import('@playwright/test').Page,
): Promise<Array<{ blockId?: string; newParentId?: string | null; newIndex?: number }>> {
  return (await getInvokeCalls(page, 'move_block')) as never
}

const rowOf = (page: import('@playwright/test').Page, id: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
const staticOf = (id: string) => `[data-testid="block-static"][data-block-id="${id}"]`
const activeMenu = (page: import('@playwright/test').Page) =>
  page.getByRole('menu', { name: 'Block actions' }).last()

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b, 'element must have a layout box').not.toBeNull()
  return b as { x: number; y: number; width: number; height: number }
}

/** Vertical centre of the first rendered text line. */
function firstLineCentre(text: Locator): Promise<number> {
  return text.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rect = [...range.getClientRects()].find((r) => r.width > 0)
    if (!rect) throw new Error('no text line')
    return rect.top + rect.height / 2
  })
}

test.describe('Block rows on touch (iPhone viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  // The 48px lane (44px slot + gap) is gone: the text starts at the row's edge
  // (one `gap-1` after the empty inline-controls slot), and no grip is rendered.
  test('text starts where the row starts: no control lane, no drag grip', async ({ page }) => {
    await openPageMobile(page, PAGE)
    const [gs1] = await blockIds(page)
    const row = rowOf(page, gs1 as string)

    await expect(row.locator('[data-testid="drag-handle"]')).toHaveCount(0)
    await expect(row.locator('.block-control-lane')).toHaveCount(0)

    const rowBox = await box(row)
    const textBox = await box(row.getByTestId('block-static'))
    expect(textBox.x - rowBox.x).toBeLessThanOrEqual(8)
  })

  // A hold on the row body (its static text) past 400 ms, then a vertical move
  // onto the row above, reorders via dnd-kit and records move_block. Drags
  // GS_2 onto GS_1 (the top row): only the first two rows hydrate reliably on
  // the CI runner (#1045), and a 2-row reorder exercises the whole path.
  test('hold, then move on the row body reorders the block and emits move_block', async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    // The tree must have settled (#968 transient-empty-render guard); the 30s
    // settle budget needs a per-test timeout above 30s.
    test.setTimeout(45_000)
    await waitForStableBlockRows(page, 2)

    const ids = await blockIds(page)
    const gs2 = ids[1] as string
    const target = page.locator('[data-testid="sortable-block"]').nth(0)
    const source = page.locator('[data-testid="sortable-block"]').nth(1).getByTestId('block-static')
    await expect(source).toBeVisible()
    await expect(target).toBeVisible()

    await clearInvokeCalls(page)
    await dragBlockTouch(page, source, target)

    // The visual order swaps — GS_2 lands at the top (visual index 0) …
    await expect.poll(async () => (await blockIds(page)).indexOf(gs2)).toBe(0)
    // … and the recorded IPC carries GS_2 moving to slot 0 ("move to top", #400).
    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs2) ?? calls.at(-1)
    expect(mine?.blockId).toBe(gs2)
    expect(mine?.newIndex).toBe(0)
    // The hold itself moved nothing: no menu opened behind the drag.
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)
  })

  // The same hold released without moving opens the BlockContextMenu, and
  // "Move Down" reorders the block via the recorded move_block.
  test('hold, then release opens the context menu and Move Down reorders the block', async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await clearInvokeCalls(page)
    await touchLongPress(page, staticOf(gs1))

    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    // A still release is a zero-movement drop: nothing moved.
    expect(await moveCalls(page)).toHaveLength(0)
    // The structural-reorder actions (Indent / Dedent / Move up/down) all live
    // behind the "Move & arrange" disclosure (2026-06-20); expand it.
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await expect(menu.getByRole('menuitem', { name: 'Indent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Dedent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Up' })).toBeVisible()
    const moveDown = menu.getByRole('menuitem', { name: 'Move Down' })
    await expect(moveDown).toBeVisible()

    await moveDown.click()

    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    expect(calls.some((c) => c.blockId === gs1)).toBe(true)
    await expect.poll(async () => (await blockIds(page)).indexOf(gs1)).toBe(1)
  })

  // The hold lifts block B, which flushes and unmounts A's editor; the still
  // release must not restore A's editor under B's menu (that pulled focus out
  // of the menu and popped the keyboard). The menu stays open, with focus in it.
  test("editing block A, a hold-release on block B leaves B's menu open and no editor mounted", async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    await focusBlockById(page, gs1)
    await expect(page.getByTestId('block-editor')).toBeVisible()

    await touchLongPress(page, staticOf(gs2))

    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('block-editor')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null))
      .toBe(true)
    // Nothing re-mounts the editor or closes the menu once things settle.
    await page.waitForTimeout(300)
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('block-editor')).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
  })

  // A parent's chevron sits at the right end of its row, level with the first
  // text line, and one tap toggles collapse. The seed has no nesting, so GS_2
  // is nested under GS_1 through the menu's Indent first.
  test("a parent's chevron sits right of the text on the first line, and one tap collapses", async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    await touchLongPress(page, staticOf(gs2))
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await menu.getByRole('menuitem', { name: 'Indent' }).click()
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)

    const parent = rowOf(page, gs1)
    const chevron = parent.getByTestId('collapse-toggle')
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    // Leaves carry no chevron.
    await expect(rowOf(page, gs2).getByTestId('collapse-toggle')).toHaveCount(0)

    const text = parent.getByTestId('block-static')
    const textBox = await box(text)
    const chevronBox = await box(chevron)
    expect(chevronBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width)
    expect(chevronBox.width).toBeGreaterThanOrEqual(44)
    expect(chevronBox.height).toBeGreaterThanOrEqual(44)
    // The glyph, not the 44px box, is what sits on the first line.
    const glyphBox = await box(chevron.locator('[data-slot="chevron-toggle"]'))
    const glyphCentre = glyphBox.y + glyphBox.height / 2
    expect(Math.abs(glyphCentre - (await firstLineCentre(text)))).toBeLessThanOrEqual(1)

    await chevron.tap()
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
    await expect(rowOf(page, gs2)).toHaveCount(0)

    await chevron.tap()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    await expect(rowOf(page, gs2)).toBeVisible()
  })

  // Inside the mounted editor a hold is the platform's text selection: neither
  // the drag (which would flush and unmount the editor) nor the menu may start.
  test('a hold inside the focused editor opens no menu and keeps the editor mounted', async ({
    page,
  }) => {
    await openPageMobile(page, PAGE)
    const [gs1] = await blockIds(page)
    await focusBlockById(page, gs1 as string)
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toBeVisible()

    await touchLongPress(page, '[data-testid="block-editor"] [contenteditable="true"]')

    await page.waitForTimeout(300)
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)
    await expect(editor).toBeVisible()
  })
})
