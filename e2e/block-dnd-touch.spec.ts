/**
 * E2E — TOUCH / narrow-viewport block drag-and-drop (#929 f2, #926 f3).
 *
 * Runs under an iPhone-class coarse-pointer + touch context so the product
 * takes its touch code paths:
 *   - `BlockGutterControls` renders the always-visible touch grip
 *     (`data-testid="drag-handle"`, regression guard for #729 / #927 f1 — the
 *     grip must be hittable at rest, not hover-revealed and not clipped).
 *   - `useBlockDnD` selects the press-and-hold PointerSensor
 *     (`{ delay: 250, tolerance: 5 }`), so a touch drag must hold past 250 ms
 *     before moving — `dragBlockTouch` does exactly that.
 *   - `useBlockTouchLongPress` opens the BlockContextMenu on a stationary
 *     400 ms press; its Move Up / Move Down actions reorder the block (#926 f3).
 *
 * Correctness is asserted on the recorded `move_block` IPC (the deterministic
 * signal — the mock backend is more permissive than production), mirroring the
 * mouse spec.
 */

import { devices } from '@playwright/test'

import {
  clearInvokeCalls,
  dragBlockTouch,
  expect,
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

test.describe('Block drag-and-drop (touch / narrow viewport)', () => {
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

  // #729 / #927 f1 regression guard: the touch grip must be a real, hittable
  // control at rest (not the hover-hidden desktop GutterButton, and not clipped
  // off the narrow gutter). We assert it is visible AND has a non-zero box.
  test('the touch drag grip is visible and hittable at rest', async ({ page }) => {
    await openPageMobile(page, PAGE)
    const block = page.locator('[data-testid="sortable-block"]').first()
    const grip = block.locator('[data-testid="drag-handle"]')

    await expect(grip).toBeVisible()
    const box = await grip.boundingBox()
    expect(box, 'touch grip must have a layout box').not.toBeNull()
    expect(box?.width ?? 0).toBeGreaterThan(0)
    expect(box?.height ?? 0).toBeGreaterThan(0)
  })

  // #929 f2 — a press-and-hold touch drag down one row emits a move_block.
  //
  // #968: this test was previously `test.skip`'d IN CI ONLY because under the
  // GH runner's parallel/headless load it intermittently lost its rendered
  // BlockTree rows mid-test (the failure snapshot showed the editor shell with
  // ZERO sortable-block rows). Root cause: `BlockTree` renders a loading
  // skeleton with no rows whenever the per-page store's `loading` flag is true,
  // and the mobile navigation path can fire a SECOND `load()` (a fresh per-page
  // store on a `PageEditor`/`BlockTree` re-mount as the search sheet tears down)
  // shortly AFTER the first content row paints. `openPageMobile` only awaits the
  // FIRST row, so the old test read `.nth(2)` straight into that transient blank
  // window. The fix waits for a STABLE populated tree (`waitForStableBlockRows`
  // — count ≥ 3 held across consecutive samples with the skeleton gone) before
  // reading ids / measuring boxes, then re-asserts the grip + target are still
  // attached immediately before the drag. No assertion is weakened.
  test('a touch drag reorders a block and emits move_block', async ({ page }) => {
    await openPageMobile(page, PAGE)

    // The drag targets the 3rd row (`.nth(2)`), so wait until at least three
    // block rows have rendered AND that count has held still — i.e. the tree is
    // not mid-(re)load (the #968 transient-empty-render guard).
    await waitForStableBlockRows(page, 3)

    const target = page.locator('[data-testid="sortable-block"]').nth(2) // onto GS_3
    await expect(target).toBeVisible()

    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await clearInvokeCalls(page)
    const grip = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="drag-handle"]')

    // Re-assert both endpoints are still attached + visible at the instant we
    // begin the drag: if a late `load()` blanked the tree between the stable-row
    // wait and here, this surfaces it deterministically instead of letting
    // `dragBlockTouch`'s `boundingBox()` resolve against a detached node.
    await expect(grip).toBeVisible()
    await expect(target).toBeVisible()

    await dragBlockTouch(page, grip, target)

    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs1) ?? calls[calls.length - 1]
    expect(mine?.blockId).toBe(gs1)
  })

  // #926 f3 — a stationary long-press on the block body opens the
  // BlockContextMenu (no drag activator there → long-press wins), and "Move
  // Down" reorders the block via the recorded move_block.
  test('long-press opens the context menu and Move Down reorders the block', async ({ page }) => {
    await openPageMobile(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await clearInvokeCalls(page)
    // Long-press the FIRST block's static body (not the grip — the long-press
    // hook fires uncontested away from the drag activator).
    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${gs1}"]`)

    const menu = page.getByRole('menu', { name: 'Block actions' })
    await expect(menu).toBeVisible()
    // The structural-reorder actions are always present (Zoom is gated on
    // hasChildren, so it is intentionally NOT asserted for a leaf block).
    await expect(menu.getByRole('menuitem', { name: 'Indent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Dedent' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move Up' })).toBeVisible()
    const moveDown = menu.getByRole('menuitem', { name: 'Move Down' })
    await expect(moveDown).toBeVisible()

    await moveDown.click()

    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    expect(calls.some((c) => c.blockId === gs1)).toBe(true)
  })
})
