import {
  clearInvokeCalls,
  dragBlock,
  dragBlockWithOffset,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for MOUSE drag-and-drop of blocks (reorder / indent / nest).
 *
 * Seed: "Getting Started" → GS_1…GS_5 at positions 0..4, ULID-ascending ids.
 *
 * As with the keyboard spec, correctness is asserted on the recorded
 * `move_block` IPC payload — since #400 a 0-based `newIndex` slot (slot 0 =
 * "first child" / "top"). The four original bugs are fixed at the root, so the
 * specs assert the CORRECT slot (and faithful visual order where the mock
 * reproduces it). See docs/dnd-ux-review.md + src/lib/__tests__/dnd-pipeline.test.ts.
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

/** Hover a block row and return its visible drag handle locator. */
async function handleFor(page: import('@playwright/test').Page, index: number) {
  const block = page.locator('[data-testid="sortable-block"]').nth(index)
  await block.hover()
  const handle = block.locator('[data-testid="drag-handle"]')
  await expect(handle).toBeVisible()
  return handle
}

test.describe('Block drag-and-drop (mouse)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('dragging a block to the TOP sends slot 0, the previously-rejected case', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 1) // GS_2
    const target = page.locator('[data-testid="sortable-block"]').nth(0) // onto GS_1 (top)
    await dragBlock(page, handle, target)

    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs2) ?? calls[calls.length - 1]
    // #400: "move to top" is slot 0. Pre-#400 this computed firstPos - 1 = 0/-1,
    // which the real backend rejected as `position <= 0`.
    expect(mine?.newIndex).toBe(0)
  })

  test('a downward drag lands the block at the target slot (off-by-one fixed)', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const [gs1] = ids

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 0) // GS_1
    const target = page.locator('[data-testid="sortable-block"]').nth(2) // drag down onto GS_3
    await dragBlock(page, handle, target)

    // #400: the projection-adjusted index is fed to computeDropIndex, so GS_1
    // lands at/after GS_3 (visual index 2), not one slot short.
    await expect.poll(async () => (await blockIds(page)).indexOf(gs1 as string)).toBe(2)

    // …and the slot it sent is 2 (after GS_3 in the post-removal order), no
    // longer a 1-based position colliding with a sibling.
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs1)
    expect(mine?.newIndex).toBe(2)
  })

  test('drag-to-indent: pushing a block right nests it under the previous sibling', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string
    const gs3 = ids[2] as string

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 2) // GS_3
    const ownRow = page.locator('[data-testid="sortable-block"]').nth(2)
    // Drag in place (over itself) + push right ~2 indent levels → child of GS_2.
    await dragBlockWithOffset(page, handle, ownRow, 50)

    await expect
      .poll(async () => {
        const calls = await moveCalls(page)
        return calls.find((c) => c.blockId === gs3)?.newParentId
      })
      .toBe(gs2)
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs3)
    expect(mine?.newIndex).toBe(0) // #400: first child of GS_2 = slot 0
  })

  test('dragging a block onto itself with no offset does not move it', async ({ page }) => {
    await openPage(page, PAGE)
    const before = await blockIds(page)

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 1) // GS_2
    const ownRow = page.locator('[data-testid="sortable-block"]').nth(1)
    await dragBlock(page, handle, ownRow)

    await page.waitForTimeout(200)
    expect(await blockIds(page)).toEqual(before)
  })

  // A one-slot downward drag SWAPS the two blocks (dnd-kit arrayMove semantics).
  // Pre-#400 this computed a no-op position (the block's own), so the order was
  // unchanged; #400 fixes the off-by-one so the swap actually happens.
  test('dragging a block down one slot swaps it with the next', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    const handle = await handleFor(page, 0) // GS_1
    const target = page.locator('[data-testid="sortable-block"]').nth(1) // onto GS_2
    await dragBlock(page, handle, target)

    // GS_1 swaps below GS_2 → index 1.
    await expect.poll(async () => (await blockIds(page)).indexOf(gs1)).toBe(1)
  })
})
