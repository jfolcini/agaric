import {
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for MULTI-SELECT drag of a PARENT + its own CHILD (#914, #976 finding 3).
 *
 * `e2e/block-dnd-multi-select.spec.ts` covers sibling multi-select drag but
 * never the parent-child co-selection case. The store/util layer is well
 * unit-tested (`computeSelectionRoots` de-nests descendants), and the real
 * caller filters via `computeSelectionRoots()` before issuing `move_block`.
 * This spec closes the end-to-end gap, asserting BOTH:
 *
 *   1. the `move_block` IPC carries ONLY the parent root — the co-selected
 *      child is NOT moved independently (it travels inside the parent subtree);
 *   2. the drag overlay badge shows the parent's SUBTREE count (parent + 1
 *      child = 2), i.e. the child is not double-counted.
 *
 * Seed: "Getting Started" → GS_1…GS_5 (flat). We build the parent-child shape
 * at runtime by indenting GS_2 under GS_1 (keyboard), then drag the pair.
 *
 * Correctness is asserted on the recorded `move_block` payloads (#400), matching
 * the existing dnd specs' approach. The badge is read mid-drag from the
 * `sortable-block-overlay-count` testid.
 */

const PAGE = 'Getting Started'

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

/** Ctrl+Click a block's static surface to toggle it into the selection. */
async function ctrlSelectById(page: import('@playwright/test').Page, blockId: string) {
  await page
    .locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    .locator('[data-testid="block-static"]')
    .click({ modifiers: ['Control'] })
}

test.describe('Block drag-and-drop (parent + child multi-select, #914)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
    await installIpcRecorder(page)
  })

  test('co-selecting a parent + its child moves ONLY the parent (one move_block), badge counts the subtree once', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    // Build the parent-child shape: indent GS_2 under GS_1 via keyboard. After
    // this, GS_2 is a child of GS_1 (its previous sibling).
    await focusBlock(page, 1) // GS_2
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expect
      .poll(async () => (await moveCalls(page)).find((c) => c.blockId === gs2)?.newParentId)
      .toBe(gs1)

    // Leave editor focus so Ctrl+Click drives block-select (not in-editor text
    // selection), then clear the recorder so only the drag's IPC is asserted.
    await page.keyboard.press('Escape')
    await clearInvokeCalls(page)

    // Ctrl+Click the parent (GS_1) AND its child (GS_2) into the selection.
    await ctrlSelectById(page, gs1)
    await ctrlSelectById(page, gs2)
    const batchToolbar = page.getByTestId('batch-toolbar')
    await expect(batchToolbar).toContainText('2')

    // Drag the parent's handle down toward GS_4. We drive the pointer manually
    // (rather than the `dragBlock` helper) so we can read the overlay badge
    // mid-flight, BEFORE the drop reconciles the tree.
    const parentRow = page.locator(`[data-testid="sortable-block"][data-block-id="${gs1}"]`)
    await parentRow.hover()
    const handle = parentRow.locator('[data-testid="drag-handle"]')
    await expect(handle).toBeVisible()
    const handleBox = await handle.boundingBox()
    const targetRow = page.locator('[data-testid="sortable-block"]').nth(3) // GS_4 (a non-selected row)
    const targetBox = await targetRow.boundingBox()
    if (!handleBox || !targetBox) throw new Error('missing bounding boxes for drag')

    const sx = handleBox.x + handleBox.width / 2
    const sy = handleBox.y + handleBox.height / 2
    const ty = targetBox.y + targetBox.height / 2

    await page.mouse.move(sx, sy)
    await page.mouse.down()
    // Distance-activated desktop sensor (8px): step vertically to the target,
    // pausing periodically so @dnd-kit's collision detection and the overlay
    // render keep pace under load.
    const steps = 20
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(sx, sy + (ty - sy) * (i / steps))
      if (i % 5 === 0) await page.waitForTimeout(50)
    }
    // Settle on the final "over" position so the overlay has committed before
    // we read the badge (mirrors the drag helper's pre-release settle).
    await page.waitForTimeout(150)

    // Mid-drag: the overlay badge reflects the parent's SUBTREE size (parent +
    // 1 child = 2). The child is counted as part of the subtree, NOT as a
    // second independent selection root (which would read 3).
    const badge = page.locator('[data-testid="sortable-block-overlay-count"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('2')

    await page.mouse.up()

    // After the drop, exactly ONE `move_block` fired — for the parent root. The
    // co-selected child was de-nested by computeSelectionRoots and travels
    // inside the parent's subtree, so it is NOT moved independently.
    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const movedIds = new Set(calls.map((c) => c.blockId))
    expect(movedIds.has(gs1)).toBe(true)
    expect(movedIds.has(gs2)).toBe(false)
  })
})
