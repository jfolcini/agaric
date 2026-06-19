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
 * (`{ blockId, newParentId, newIndex }`) via the IPC recorder, NOT on the
 * mock's resulting visual order. This is deliberate: the web/Tauri MOCK backend
 * is more permissive than the real Rust backend, so the slot the UI *sends* is
 * the deterministic signal. Since #400 the slot is a 0-based `newIndex` (slot 0
 * = "first child" / "top"); the four original bugs (off-by-one, collision,
 * non-positive top/first-child) are fixed at the root, so these specs assert the
 * CORRECT slot. See src/lib/__tests__/dnd-pipeline.test.ts.
 */

const PAGE = 'Getting Started'

/** Read the ordered list of block ids currently rendered. */
async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

/** Most recent recorded move_block payload, or null. */
async function lastMove(
  page: import('@playwright/test').Page,
): Promise<{ blockId?: string; newParentId?: string | null; newIndex?: number } | null> {
  const calls = await getInvokeCalls(page, 'move_block')
  return (calls[calls.length - 1] as never) ?? null
}

test.describe('Keyboard block movement', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  // ── Indent / dedent (these work correctly) ─────────────────────────────

  test('Ctrl+Shift+ArrowRight indents under the previous sibling (parent + slot 0)', async ({
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
    expect(move?.newIndex).toBe(0) // #400: first (only) child = slot 0
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

  // ── Move up — "move to top" used to emit a rejected position<=0 ─────────

  test('moving the 2nd block up emits slot 0 (top), the previously-rejected case', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string

    await focusBlock(page, 1) // GS_2 (sibling slot 1)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowUp')

    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs2)
    const move = await lastMove(page)
    // #400: moving up = previous sibling's slot (sibIndex - 1) = 0. Pre-#400 this
    // emitted `position - 1 = -1`, which the real backend rejected.
    expect(move?.newIndex).toBe(0)
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

  // ── Move down — used to emit a position colliding with the next-next sibling

  test('moving a block down emits the slot that swaps it past the next sibling', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    await focusBlock(page, 0) // GS_1 (sibling slot 0)
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+Shift+ArrowDown')

    await expect.poll(async () => (await lastMove(page))?.blockId).toBe(gs1)
    const move = await lastMove(page)
    // #400: moving down = slot `sibIndex + 1` among the OTHER children (block
    // excluded) = 1, landing it just after GS_2. Pre-#400 this emitted a 1-based
    // position colliding with GS_3, so ULID (not intent) decided the order.
    expect(move?.newIndex).toBe(1)
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
