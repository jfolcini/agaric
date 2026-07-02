import {
  clearInvokeCalls,
  dragBlock,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for MULTI-SELECT drag of blocks (#914).
 *
 * When several blocks are multi-selected (Ctrl+Click) and the user drags one of
 * them, the WHOLE selection moves — contiguous, preserving relative document
 * order. Pre-#914 the selection was silently ignored on drop and only the
 * dragged block moved.
 *
 * Seed: "Getting Started" → GS_1…GS_5 at positions 0..4, ULID-ascending ids.
 *
 * As with the single-block mouse spec, correctness is asserted on the recorded
 * IPC payloads. #2274 batched the multi-select drag: the WHOLE selection moves
 * through ONE `move_blocks_batch` IPC (ordered ids + the 0-based `newIndex`
 * start slot), replacing the old per-root `move_block` loop. A single-block
 * drag still issues a plain `move_block`.
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

async function batchMoveCalls(
  page: import('@playwright/test').Page,
): Promise<Array<{ blockIds?: string[]; newParentId?: string | null; newIndex?: number }>> {
  return (await getInvokeCalls(page, 'move_blocks_batch')) as never
}

/** Hover a block row and return its visible drag handle locator. */
async function handleFor(page: import('@playwright/test').Page, index: number) {
  const block = page.locator('[data-testid="sortable-block"]').nth(index)
  await block.hover()
  const handle = block.locator('[data-testid="drag-handle"]')
  await expect(handle).toBeVisible()
  return handle
}

/**
 * Ctrl+Click a block's static surface to toggle it into the selection.
 *
 * Click the leading-text corner rather than the geometric centre: a block whose
 * text contains an inline link/reference chip can have that chip sitting at the
 * centre, and a Ctrl+click on a chip is consumed by the chip (it does not toggle
 * the selection). The top-left of `block-static` is reliably the start of the
 * plain text for these seed blocks.
 */
async function ctrlSelect(page: import('@playwright/test').Page, index: number) {
  await page
    .locator('[data-testid="sortable-block"]')
    .nth(index)
    .locator('[data-testid="block-static"]')
    .click({ modifiers: ['Control'], position: { x: 8, y: 8 } })
}

test.describe('Block drag-and-drop (multi-select, #914)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
    await installIpcRecorder(page)
  })

  test('dragging one of two selected blocks moves BOTH (one move_blocks_batch)', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    // Select GS_1 and GS_2, then drag GS_1 down onto GS_4 (index 3).
    await ctrlSelect(page, 0)
    await ctrlSelect(page, 1)
    const batchToolbar = page.getByTestId('batch-toolbar')
    await expect(batchToolbar).toContainText('2')

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 0) // GS_1 (a selected block)
    const target = page.locator('[data-testid="sortable-block"]').nth(3) // onto GS_4
    await dragBlock(page, handle, target)

    // Both blocks moved through ONE batched IPC (#2274) — the selection was
    // NOT silently ignored, and no per-root move_block loop fired.
    await expect.poll(async () => (await batchMoveCalls(page)).length).toBeGreaterThanOrEqual(1)
    const calls = await batchMoveCalls(page)
    const movedIds = new Set(calls[0]?.blockIds ?? [])
    expect(movedIds.has(gs1)).toBe(true)
    expect(movedIds.has(gs2)).toBe(true)
    expect(await moveCalls(page)).toHaveLength(0)
  })

  test('moved selection lands at consecutive slots, preserving document order', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    await ctrlSelect(page, 0)
    await ctrlSelect(page, 1)

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 0) // GS_1
    const target = page.locator('[data-testid="sortable-block"]').nth(3) // GS_4
    await dragBlock(page, handle, target)

    await expect.poll(async () => (await batchMoveCalls(page)).length).toBeGreaterThanOrEqual(1)
    const call = (await batchMoveCalls(page))[0]
    // GS_1 precedes GS_2 in the document, so the batch carries [GS_1, GS_2] in
    // that order — the backend lands them at consecutive slots newIndex,
    // newIndex + 1 under the single requested parent (#2274).
    expect(call?.blockIds).toEqual([gs1, gs2])
    expect(call?.newIndex).toBeDefined()
  })

  test('dragging an UNSELECTED block ignores the selection (single move_block)', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string
    const gs3 = ids[2] as string

    // Select GS_1 + GS_2, but drag GS_3 (not in the selection).
    await ctrlSelect(page, 0)
    await ctrlSelect(page, 1)

    await clearInvokeCalls(page)
    const handle = await handleFor(page, 2) // GS_3
    const target = page.locator('[data-testid="sortable-block"]').nth(4) // onto GS_5
    await dragBlock(page, handle, target)

    await expect.poll(async () => (await moveCalls(page)).length).toBeGreaterThan(0)
    const calls = await moveCalls(page)
    const movedIds = new Set(calls.map((c) => c.blockId))
    // Only GS_3 moved — the (other) selected blocks stayed put.
    expect(movedIds.has(gs3)).toBe(true)
    expect(movedIds.has(gs1)).toBe(false)
    expect(movedIds.has(gs2)).toBe(false)
  })
})
