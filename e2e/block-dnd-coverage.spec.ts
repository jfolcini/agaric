import {
  dragBlockWithOffset,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for drag-layer edge cases the review found untested (#923).
 *
 * Asserts on the recorded `move_block` IPC (the deterministic signal — the mock
 * backend is more permissive than the real one, so the slot the UI *sends* is
 * what we check), not the mock's reconciled order.
 */

const PAGE = 'Getting Started'

async function moveCalls(page: import('@playwright/test').Page) {
  return (await getInvokeCalls(page, 'move_block')) as Array<Record<string, unknown>>
}

async function handleFor(page: import('@playwright/test').Page, index: number) {
  const block = page.locator('[data-testid="sortable-block"]').nth(index)
  await block.hover()
  return block.locator('[data-testid="drag-handle"]')
}

test.describe('Drag-layer edge cases (#923)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  // #923 f5 — a sub-threshold nudge that releases over the block's OWN row must
  // be treated as a click, never a move (Logseq behaviour). The 10px horizontal
  // offset is below the 20px dead zone, so the projected depth never changes and
  // active === over → no reorder fires.
  test('a sub-threshold self-drop (offset < dead zone) emits no move_block', async ({ page }) => {
    await openPage(page, PAGE)
    const block = page.locator('[data-testid="sortable-block"]').nth(1)
    const handle = await handleFor(page, 1)

    // Drag block 1 onto its own row with a 10px offset (< DEAD_ZONE_PX = 20).
    await dragBlockWithOffset(page, handle, block, 10)

    // Give any erroneous move a beat to fire, then assert none did.
    await page.waitForTimeout(300)
    expect((await moveCalls(page)).length).toBe(0)
  })
})
