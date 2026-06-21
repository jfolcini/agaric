/**
 * E2E — touch gestures on block rows (#927 f2).
 *
 * Runs under an iPhone-class coarse-pointer + touch context so the product's
 * touch-only surfaces and gesture hooks are live:
 *
 *   (a) long-press → BlockContextMenu. Zoom in is available for any block, and
 *       the structural ops (Indent / Dedent / Move) live behind the
 *       "Move & arrange" disclosure — `useBlockTouchLongPress`.
 *   (b) zoom into a block via the context-menu "Zoom in" item (the inline zoom
 *       bullet was removed 2026-06-20; zoom is menu-only now).
 *   (c) swipe-left-to-delete past the 200 px auto-delete threshold fires the
 *       delete + the Gmail-style "Undo" toast — `useBlockSwipeActions` +
 *       `SortableBlock`'s `handleSwipeDelete`.
 *   (d) History and Delete (moved off the gutter, 2026-06-20) are reachable
 *       from the long-press context menu.
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

  // (a) — long-press opens the menu. Zoom in is available for any block, and
  // the structural ops live behind the "Move & arrange" disclosure. We expand
  // that disclosure to reach Indent and drive it (nesting GS_2 under GS_1) via
  // a pure touch path.
  test('long-press opens BlockContextMenu with Zoom + Move & arrange (Indent/Dedent/Move)', async ({
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

    // Leaf block: Zoom in is available (ungated, 2026-06-20). The structural ops
    // (Indent / Dedent / Move) are collapsed behind the "Move & arrange"
    // disclosure; expand it to reveal them.
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    let menu = activeMenu()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Zoom in' })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await expect(menu.getByRole('menuitem', { name: 'Indent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Dedent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Up' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Down' })).toBeVisible()

    // Dismiss this menu before opening the next (the spec never clicked an
    // action on GS_1's menu, so it would otherwise stay open and collide with
    // GS_2's menu). Escape → `onClose`; wait for full unmount.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)

    // Make GS_1 a parent: long-press GS_2 → Move & arrange → Indent (nests it).
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs2}"]`)
    menu = activeMenu()
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await clearInvokeCalls(page)
    await menu.getByRole('menuitem', { name: 'Indent' }).click()
    await expect
      .poll(async () => (await getInvokeCalls(page, 'move_block')).length)
      .toBeGreaterThan(0)
  })

  // (b) — zooming into a block via the context-menu "Zoom in" item swaps the
  // visible block set to the block's own subtree, so the BlockZoomBar
  // breadcrumb trail appears. Zoom is available for any block (the old inline
  // zoom bullet was removed 2026-06-20).
  test('zooming via the context-menu Zoom in item shows the breadcrumb trail', async ({ page }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const activeMenu = () => page.getByRole('menu', { name: 'Block actions' }).last()

    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    const menu = activeMenu()
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Zoom in' }).click()

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

  // (d) — History and Delete moved off the gutter (2026-06-20) into the
  // long-press context menu. Assert both are reachable there on touch.
  test('long-press menu surfaces History and Delete', async ({ page }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const activeMenu = () => page.getByRole('menu', { name: 'Block actions' }).last()

    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    const menu = activeMenu()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'History' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
  })
})
