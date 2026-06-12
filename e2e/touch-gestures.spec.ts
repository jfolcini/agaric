/**
 * E2E — touch gestures on block rows (#927 f2).
 *
 * Runs under an iPhone-class coarse-pointer + touch context so the product's
 * touch-only surfaces and gesture hooks are live:
 *
 *   (a) long-press → BlockContextMenu with Indent / Dedent / Move (always) and
 *       Zoom in (once the block has children) — `useBlockTouchLongPress`.
 *   (b) tap-the-bullet zoom — `BlockInlineControls` `data-testid="block-bullet"`
 *       calls `zoomIn(blockId)` (#927 f3 / Logseq's signature gesture).
 *   (c) swipe-left-to-delete past the 200 px auto-delete threshold fires the
 *       delete + the Gmail-style "Undo" toast — `useBlockSwipeActions` +
 *       `SortableBlock`'s `handleSwipeDelete`.
 *   (d) the more-actions overflow Sheet opens — `BlockGutterControls` touch
 *       render (`data-testid="more-actions"`).
 *
 * Gestures are driven via real `TouchEvent`s (`touchLongPress` / `touchSwipe`
 * in helpers) because these handlers bind to React `onTouch*`, not the pointer
 * stream that @dnd-kit consumes.
 */

import { devices } from '@playwright/test'

import {
  clearInvokeCalls,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openPageMobile,
  test,
  touchLongPress,
  touchSwipe,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'

const iPhone13 = devices['iPhone 13']

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

test.describe('Touch gestures (iPhone viewport)', () => {
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
    await openPageMobile(page, PAGE)
  })

  // (a) — long-press opens the menu with the structural ops, and Zoom in
  // appears once the block has children. We first Indent GS_2 under GS_1 via
  // the menu (a pure touch path), then re-open on GS_1 to see Zoom in.
  test('long-press opens BlockContextMenu with Indent/Dedent/Move + Zoom (with children)', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    // Scope to the ACTIVE (last-mounted) menu. The BlockContextMenu unmounts
    // via a fade/zoom animation, so when one menu is dismissed and the next is
    // long-pressed open the two portals can briefly coexist — a root-level
    // `getByRole('menu')` then trips strict-mode ("resolved to 2 elements").
    // `.last()` always picks the freshly-opened menu (mirrors the `activeMenu`
    // helper in helpers.ts).
    const activeMenu = () => page.getByRole('menu', { name: 'Block actions' }).last()

    // Leaf block: structural ops present, Zoom in absent (gated on children).
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    let menu = activeMenu()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Indent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Dedent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Up' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Down' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Zoom in' })).toHaveCount(0)

    // Dismiss this menu before opening the next (the spec never clicked an
    // action on GS_1's menu, so it would otherwise stay open and collide with
    // GS_2's menu). Escape → `onClose`; wait for full unmount.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)

    // Make GS_1 a parent: long-press GS_2 → Indent (nests it under GS_1).
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs2}"]`)
    menu = activeMenu()
    await expect(menu).toBeVisible()
    await clearInvokeCalls(page)
    await menu.getByRole('menuitem', { name: 'Indent' }).click()
    await expect
      .poll(async () => (await getInvokeCalls(page, 'move_block')).length)
      .toBeGreaterThan(0)

    // GS_1 now has a child → its menu surfaces Zoom in.
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    menu = activeMenu()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Zoom in' })).toBeVisible()
  })

  // (b) — tapping the bullet zooms into the block (Logseq's signature gesture).
  // Zooming swaps the visible block set to the block's own subtree, so the
  // tapped block leaves the sortable list (or a BlockZoomBar appears). We assert
  // the zoom IPC / view change via the block's bullet click.
  test('tapping the bullet zooms into the block', async ({ page }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    const bullet = page.locator(
      `[data-testid="sortable-block"][data-block-id="${gs1}"] [data-testid="block-bullet"]`,
    )
    await expect(bullet).toBeVisible()
    await bullet.click()

    // After zooming in, the BlockZoomBar breadcrumb trail renders (the bullet's
    // `zoomIn` is NOT gated on children, unlike the context-menu Zoom item).
    await expect(page.getByRole('navigation', { name: /zoom breadcrumbs/i })).toBeVisible()
  })

  // (c) — a long left swipe past the 200 px auto-delete threshold deletes the
  // block and shows the recoverable "Undo" toast (#927 f7).
  test('swipe-left past the threshold deletes the block and shows the Undo toast', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await clearInvokeCalls(page)
    // 220 px left swipe > AUTO_DELETE_THRESHOLD (200) → immediate delete.
    await touchSwipe(page, `[data-testid="sortable-block"][data-block-id="${gs1}"]`, -220)

    // The Gmail-style undo toast ("Block deleted" + "Undo") is the recoverability net.
    const toasts = page.getByLabel('Notifications alt+T')
    await expect(toasts.getByText('Block deleted')).toBeVisible()
    await expect(toasts.getByRole('button', { name: 'Undo' })).toBeVisible()

    // The delete reached the backend.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'delete_block')).length)
      .toBeGreaterThan(0)
  })

  // (d) — the more-actions overflow Sheet opens on touch. The overflow button
  // inherits the hover/active reveal contract (no hover on touch), so we focus
  // the block first (→ `.block-active`) to surface it, then tap it.
  test('the more-actions overflow sheet opens', async ({ page }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${gs1}"]`)

    // Focus the block to apply `.block-active`, which reveals the gutter overflow.
    await page.locator(`[data-testid="block-static"][data-block-id="${gs1}"]`).click()
    await expect(
      page.locator(
        `[data-testid="sortable-block"][data-block-id="${gs1}"] [data-testid="block-editor"]`,
      ),
    ).toBeVisible()

    const moreActions = block.locator('[data-testid="more-actions"]')
    await expect(moreActions).toBeVisible()
    await moreActions.click()

    // The overflow Sheet renders its action rows (History / Delete).
    await expect(page.getByTestId('more-actions-delete')).toBeVisible()
  })
})
