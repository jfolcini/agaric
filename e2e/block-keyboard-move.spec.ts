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
 * E2E for KEYBOARD block movement (indent / dedent / move-up / move-down).
 *
 * Seed (tauri-mock seed.ts) — "Getting Started" has 5 child blocks GS_1…GS_5
 * at consecutive positions 0,1,2,3,4 with ULID-ascending ids (BLOCK01…BLOCK05).
 *
 * Assertions are made primarily on the recorded `move_block` IPC payload
 * (`{ blockId, newParentId, newPosition }`) via the IPC recorder, NOT on the
 * mock's resulting visual order. This is deliberate: the web/Tauri MOCK backend
 * is more permissive than the real Rust backend — it accepts `position <= 0`
 * and tie-breaks equal positions by insertion order — so several real-backend
 * bugs are HIDDEN at the visual layer and only visible in the payload the UI
 * sends. See docs/dnd-ux-review.md and src/lib/__tests__/dnd-pipeline.test.ts.
 */

const PAGE = 'Getting Started'

/** Read the ordered list of block ids currently rendered. */
async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-testid="sortable-block"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-block-id') ?? ''),
  )
}

/** Most recent recorded move_block payload, or null. */
async function lastMove(
  page: import('@playwright/test').Page,
): Promise<{ blockId?: string; newParentId?: string | null; newPosition?: number } | null> {
  const calls = await getInvokeCalls(page, 'move_block')
  return (calls[calls.length - 1] as never) ?? null
}

test.describe('Keyboard block movement', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  // ── Indent / dedent (these work correctly) ─────────────────────────────

  test('Ctrl+Shift+ArrowRight indents under the previous sibling (parent + position 1)', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const [gs1, gs2, gs3] = ids
    expect(gs3).toBeTruthy()

    await focusBlock(page, 2) // GS_3
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowRight')

    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs3)
    const move = await lastMove(page)
    expect(move?.newParentId).toBe(gs2) // becomes a child of GS_2
    expect(move?.newPosition).toBe(1) // first (only) child — a SAFE position
    void gs1
  })

  test('Ctrl+Shift+ArrowLeft dedents back to the root level', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string
    const gs3 = ids[2] as string

    // Indent first → GS_3 becomes a child of GS_2.
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expect
      .poll(async () => {
        const m = await lastMove(page)
        return m?.blockId === gs3 && m?.newParentId === gs2
      })
      .toBe(true)

    // …then dedent → GS_3 returns to the page root (parent = the page, NOT GS_2).
    // At a page's top level blocks carry `parent_id = <page id>`, not null, so
    // we assert it is simply no longer a child of GS_2.
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowLeft')
    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs3)
    const move = await lastMove(page)
    expect(move?.newParentId).not.toBe(gs2) // no longer nested under GS_2
  })

  // ── Move up — reveals the position<=0 rejection bug ────────────────────

  test('BUG: moving the 2nd block up emits a non-positive position the real backend rejects', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string

    await focusBlock(page, 1) // GS_2 (prev sibling GS_1 is at position 0)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowUp')

    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs2)
    const move = await lastMove(page)
    // prevSibling(GS_1).position(0) - 1 = -1. The mock accepts it; the real
    // backend rejects `position <= 0` ("position must be positive").
    expect(move?.newPosition as number).toBeLessThanOrEqual(0)
  })

  test('moving the FIRST block up is a no-op (no move_block IPC)', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page, 0) // GS_1
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowUp')

    // Give the handler a beat; assert nothing was sent.
    await page.waitForTimeout(200)
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(0)
  })

  // ── Move down — reveals the position-collision bug ─────────────────────

  test('BUG: moving a block down emits a position that collides with an existing sibling', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await focusBlock(page, 0) // GS_1 (next sibling GS_2 at position 1, GS_3 at 2)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowDown')

    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs1)
    const move = await lastMove(page)
    // nextSibling(GS_2).position(1) + 1 = 2, which EQUALS GS_3's position →
    // with no backend renumbering the order is then decided by ULID, not intent.
    expect(move?.newPosition).toBe(2)
  })

  test('moving the LAST block down is a no-op (no move_block IPC)', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page, 4) // GS_5
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowDown')

    await page.waitForTimeout(200)
    expect(await getInvokeCalls(page, 'move_block')).toHaveLength(0)
  })

  // ── Subtree integrity: moving a parent carries its child ───────────────

  test('moving a parent up carries its indented child with it', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string
    const gs3 = ids[2] as string

    // Indent GS_3 under GS_2 → GS_2 is now a parent of GS_3.
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expect
      .poll(async () => {
        const m = await lastMove(page)
        return m?.blockId === gs3 && m?.newParentId === gs2
      })
      .toBe(true)

    // Move GS_2 up. GS_3 (its child) must remain directly below it and nested.
    await focusBlock(page, 1)
    await page.keyboard.press('Control+Shift+ArrowUp')

    await expect
      .poll(async () => {
        const order = await blockIds(page)
        const i2 = order.indexOf(gs2)
        const i3 = order.indexOf(gs3)
        return i3 === i2 + 1 // child still immediately follows its parent
      })
      .toBe(true)
  })
})
