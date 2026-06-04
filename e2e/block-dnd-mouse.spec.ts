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
 * `move_block` IPC payload where the web MOCK backend hides the real bug (it
 * accepts `position <= 0` and tie-breaks by insertion order). Visual-order
 * assertions are used only where the mock faithfully reproduces the behaviour.
 * See docs/dnd-ux-review.md + src/lib/__tests__/dnd-pipeline.test.ts.
 */

const PAGE = 'Getting Started'

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

async function moveCalls(
  page: import('@playwright/test').Page,
): Promise<Array<{ blockId?: string; newParentId?: string | null; newPosition?: number }>> {
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

  test('BUG: dragging a block to the TOP sends a non-positive position the real backend rejects', async ({
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
    // computePosition → firstPos - 1 = -1. Mock accepts it; the real backend
    // rejects `position <= 0` ("position must be positive") → error toast.
    expect(mine?.newPosition as number).toBeLessThanOrEqual(0)
  })

  test('BUG: a downward drag is off-by-one — the block lands one slot short of the target', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const [gs1] = ids

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 0) // GS_1
    const target = page.locator('[data-testid="sortable-block"]').nth(2) // drag down onto GS_3
    await dragBlock(page, handle, target)

    // Intended: GS_1 lands at/after GS_3 (index 2). Actual: the raw over-index
    // is fed to computePosition, so GS_1 only advances ONE slot → index 1.
    await expect.poll(async () => (await blockIds(page)).indexOf(gs1 as string)).toBe(1)

    // …and the IPC position it sent collides with GS_3's seed position (2).
    const calls = await moveCalls(page)
    const mine = calls.find((c) => c.blockId === gs1)
    expect(mine?.newPosition).toBe(2)
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
    expect(mine?.newPosition).toBe(1) // first child of GS_2 — a SAFE position
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

  // Desired behaviour marker: a one-slot downward drag should SWAP the two
  // blocks (dnd-kit arrayMove semantics). Today it computes a no-op position
  // (the block's own), so the order is unchanged. `test.fail` keeps CI green
  // and flips red once the off-by-one is fixed.
  test('DESIRED (currently broken): dragging a block down one slot swaps it with the next', async ({
    page,
  }) => {
    test.fail()
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    const handle = await handleFor(page, 0) // GS_1
    const target = page.locator('[data-testid="sortable-block"]').nth(1) // onto GS_2
    await dragBlock(page, handle, target)

    // Desired: GS_1 swaps below GS_2 → index 1.
    await expect.poll(async () => (await blockIds(page)).indexOf(gs1)).toBe(1)
  })
})
