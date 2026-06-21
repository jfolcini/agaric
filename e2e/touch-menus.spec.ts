/**
 * E2E — TOUCH-only block menus (#1171, the two remaining gaps).
 *
 * Runs under an iPhone-class coarse-pointer + touch context so the product takes
 * its touch code paths (`useIsTouch()` → true, `useBlockTouchLongPress` armed):
 *
 *   1. History + Delete via the long-press context menu. These actions moved off
 *      the gutter (2026-06-20 — the touch more-actions overflow Sheet was
 *      removed) into the `BlockContextMenu`. We assert a long-press surfaces both
 *      History and Delete, and that tapping Delete FIRES it (→ `delete_block`
 *      IPC, the deterministic signal used by the swipe-delete test in
 *      `touch-gestures.spec.ts`) and removes the block.
 *
 *   2. External-link LONG-PRESS context menu. The right-click path is covered by
 *      `external-link-context-menu.spec.ts`; this is the TOUCH long-press path.
 *      `useBlockTouchLongPress.handleTouchStart` reads `e.target.closest('.external-link')`
 *      at the 400 ms (`LONG_PRESS_DELAY`) mark and forwards its href as `linkUrl`,
 *      so `BlockContextMenu` surfaces the link-aware "Open link" / "Copy URL"
 *      items (only rendered when `linkUrl` is present).
 *
 * Touch gestures are driven via real `TouchEvent`s (`touchLongPress` in helpers)
 * because the long-press hook binds to React `onTouch*`, not the pointer stream.
 * `touchLongPress` defaults to a 550 ms hold — comfortably past the hook's
 * 400 ms `LONG_PRESS_DELAY` (see `src/hooks/useBlockTouchLongPress.ts` +
 * `src/hooks/__tests__/useBlockTouchLongPress.test.ts`); that is the SAME hold
 * `touch-gestures.spec.ts` / `block-dnd-touch.spec.ts` rely on, so we inherit
 * the proven timing rather than invent our own.
 *
 * The external link is created on the TOUCH viewport via the editor's `autolink`
 * input rule (`external-link.ts` → `autolink: true`): typing a bare URL followed
 * by a space wraps it in the link mark. We cannot use the SelectionBubbleMenu's
 * "External link" button here — that bubble is suppressed on coarse pointers
 * (#925 f4, `SelectionBubbleMenu` `!isTouch` guard) — so the desktop
 * `external-link-context-menu.spec.ts` link-creation flow is unavailable.
 */

import { devices } from '@playwright/test'

import {
  activeMenu,
  clearInvokeCalls,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  openPageMobile,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'

// iPhone 13 viewport/touch flags (minus `defaultBrowserType`, which Playwright
// rejects inside a describe-level `test.use`). Mirrors `touch-gestures.spec.ts`
// / `block-dnd-touch.spec.ts`.
const iPhone13 = devices['iPhone 13']

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

test.describe('Touch block menus (iPhone viewport, #1171)', () => {
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

  // ── Gap 1 — History + Delete via the long-press context menu (touch) ──
  //
  // History and Delete moved off the gutter into the BlockContextMenu
  // (2026-06-20). We long-press to open the menu, assert both items are present,
  // then tap Delete — the deterministic item: `onDelete(blockId)` →
  // `delete_block` IPC (the same signal the swipe-delete test in
  // `touch-gestures.spec.ts` asserts) — and confirm the block is removed.
  test('long-press menu surfaces History + Delete, and Delete fires and removes the block', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'History' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    await clearInvokeCalls(page)
    await menu.getByRole('menuitem', { name: 'Delete' }).click()

    await expect
      .poll(async () => (await getInvokeCalls(page, 'delete_block')).length)
      .toBeGreaterThan(0)
    // The action also dismisses the menu …
    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)
    // …and the block is gone from the tree.
    await expect.poll(async () => (await blockIds(page)).includes(gs1)).toBe(false)
  })

  // ── Gap 2 — external-link long-press context menu (touch) ──
  //
  // The right-click path lives in `external-link-context-menu.spec.ts`; this is
  // the touch long-press counterpart. We build the link with the editor's
  // `autolink` rule (type URL + trailing space), blur so the block re-renders to
  // its STATIC `span.external-link` (which carries `data-href`), then long-press
  // it. The 400 ms `LONG_PRESS_DELAY` reads the link via `closest('.external-link')`
  // and surfaces the link-aware menu items.
  test('long-pressing an external link opens the menu with Open link / Copy URL', async ({
    page,
  }) => {
    const url = 'https://example.com'
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    // Focus the first block and append a bare URL + trailing space so the
    // `autolink` input rule wraps it in the external-link mark.
    const editor = await focusBlockById(page, gs1)
    await page.keyboard.press('End')
    await editor.pressSequentially(` ${url} `, { delay: 20 })

    // The link is visible in the live editor (TipTap `a.external-link`).
    await expect(
      page.locator('[data-testid="block-editor"] [data-testid="external-link"]'),
    ).toBeVisible()

    // Blur so the block flushes to its STATIC render — the long-press path reads
    // the static `span.external-link[data-href]`, not the editor's live anchor.
    // Tapping the header (non-focusable) blurs without splitting the paragraph.
    await page.locator('header').first().click()
    const staticLink = page
      .locator(`[data-testid="sortable-block"][data-block-id="${gs1}"]`)
      .locator('[data-testid="block-static"] [data-testid="external-link"]')
    await expect(staticLink).toBeVisible()

    // Long-press the static link. `touchLongPress` dispatches a real
    // `touchstart` whose `target` is the link element, so the long-press hook's
    // `closest('.external-link')` resolves the href → link-aware menu. The
    // default 550 ms hold clears the 400 ms `LONG_PRESS_DELAY` (matches
    // `touch-gestures.spec.ts`).
    await touchLongPress(
      page,
      `[data-testid="sortable-block"][data-block-id="${gs1}"] [data-testid="block-static"] [data-testid="external-link"]`,
    )

    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Open link' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Copy URL' })).toBeVisible()
  })
})
