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

  // #929 f2 — a press-and-hold touch drag emits a move_block and reorders.
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
  // held across consecutive samples with the skeleton gone) before reading ids /
  // measuring boxes, then re-asserts the grip + target are still attached
  // immediately before the drag.
  //
  // #1045: the drag previously targeted the 3rd row (`.nth(2)`) and waited for
  // THREE hydrated rows. `SortableBlockWrapper` virtualizes the tree — off-
  // screen blocks render as empty `block-placeholder` <li>s and only promote to
  // `sortable-block` rows once on-screen (`viewport.isOffscreen`). The seeded
  // "Getting Started" page has 5 root children (GS_1…GS_5). On the iPhone-13
  // viewport (390×844) only the first rows that fit on screen hydrate; locally
  // three settle, but the resource-starved GH CI runner deterministically
  // hydrates only TWO `sortable-block` rows (GS_3 stays an off-screen
  // placeholder) even after a 30s budget — so requiring 3 rows could never pass
  // in CI. A 2-row reorder fully exercises the press-and-hold touch drag path,
  // so the test now drags GS_2's grip ONTO GS_1 (the top row) and asserts both
  // the emitted `move_block` (slot 0 / "move to top") AND the resulting visual
  // order swap — using only the two rows that hydrate reliably in CI.
  test('a touch drag reorders a block and emits move_block', async ({ page }) => {
    await openPageMobile(page, PAGE)

    // Wait until the two on-screen rows (GS_1, GS_2) have hydrated AND that
    // count has held still — the tree is settled, not mid-(re)load and not a
    // partial CI paint (the #968 transient-empty-render + #1045 incremental-
    // paint guard). The 30s settle budget needs a per-test timeout above 30s.
    test.setTimeout(45_000)
    await waitForStableBlockRows(page, 2)

    const ids = await blockIds(page)
    const gs2 = ids[1] as string

    const target = page.locator('[data-testid="sortable-block"]').nth(0) // onto GS_1 (top)
    await expect(target).toBeVisible()

    await clearInvokeCalls(page)
    // Grip of the SECOND row (GS_2) — drag it up over the first row.
    const grip = page
      .locator('[data-testid="sortable-block"]')
      .nth(1)
      .locator('[data-testid="drag-handle"]')

    // Re-assert both endpoints are still attached + visible at the instant we
    // begin the drag: if a late `load()` blanked the tree between the stable-row
    // wait and here, this surfaces it deterministically instead of letting
    // `dragBlockTouch`'s `boundingBox()` resolve against a detached node.
    await expect(grip).toBeVisible()
    await expect(target).toBeVisible()

    await dragBlockTouch(page, grip, target)

    // The visual order swaps — GS_2 lands at the top (visual index 0).
    await expect.poll(async () => (await blockIds(page)).indexOf(gs2)).toBe(0)

    // …and the recorded IPC carries GS_2 moving to slot 0 ("move to top", #400).
    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs2) ?? calls[calls.length - 1]
    expect(mine?.blockId).toBe(gs2)
    expect(mine?.newIndex).toBe(0)
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
