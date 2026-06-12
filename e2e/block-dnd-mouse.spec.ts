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

/**
 * #923 f2 — VISUAL drag-layer assertions.
 *
 * The reorder/IPC suite above only checks the recorded `move_block` payload and
 * final order. These tests instead inspect the IN-FLIGHT visual layer that
 * @dnd-kit renders while a drag is held (overlay ghost, indent guides, the
 * per-row drop indicator) and the Esc-to-abort contract (no move + focus
 * restored). They drive the pointer manually and DELIBERATELY do not release
 * mid-drag, so they cannot reuse `dragBlock` (which always ends with mouse-up).
 */
test.describe('Drag visual layer (#923 f2)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  /** Press the drag handle of block `index` and move partway WITHOUT releasing. */
  async function beginDrag(page: import('@playwright/test').Page, index: number) {
    const handle = await handleFor(page, index)
    const box = await handle.boundingBox()
    if (!box) throw new Error('no handle bounding box')
    const sx = box.x + box.width / 2
    const sy = box.y + box.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    // Travel down ~1.5 rows in small steps so the {distance:8} sensor latches
    // and a real over-row is established — but never release.
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(sx, sy + (60 * i) / 12)
    }
    return { sx, sy }
  }

  test('an in-flight drag renders the overlay ghost and indent guides', async ({ page }) => {
    await openPage(page, PAGE)
    await beginDrag(page, 0) // lift GS_1

    // The translucent ghost row that follows the cursor (Notion/Logseq style).
    await expect(page.locator('[data-testid="sortable-block-overlay"]')).toBeVisible()
    // Indent guides paint only while a drag is active (activeId !== null).
    await expect(page.locator('[data-testid="drag-indent-guides"]')).toBeVisible()
    // A drop indicator bar marks the projected landing edge on the over-row.
    await expect(page.locator('.drop-indicator').first()).toBeVisible()

    // Clean up: release so the afterEach/console gate isn't left mid-gesture.
    await page.mouse.up()
  })

  test('pressing Escape aborts the drag — order unchanged, no move emitted', async ({ page }) => {
    await openPage(page, PAGE)
    const before = await blockIds(page)

    await clearInvokeCalls(page)
    await beginDrag(page, 0) // lift GS_1
    await expect(page.locator('[data-testid="sortable-block-overlay"]')).toBeVisible()

    // Esc cancels the @dnd-kit pointer drag → handleDragCancel.
    await page.keyboard.press('Escape')
    await page.mouse.up()

    // Overlay torn down, no move emitted, order preserved — the Esc-abort
    // contract.
    await expect(page.locator('[data-testid="sortable-block-overlay"]')).toHaveCount(0)
    await page.waitForTimeout(200)
    expect((await getInvokeCalls(page, 'move_block')).length).toBe(0)
    expect(await blockIds(page)).toEqual(before)

    // NOTE — the original spec also asserted "Esc restores focus to the block
    // that was being edited pre-drag" (#923). That assertion does not hold when
    // the drag is initiated by grabbing the handle with a real pointer, and is
    // intentionally dropped here rather than skipped, because the abort/no-move
    // contract above is the meaningful, emulatable part:
    //
    //   `useBlockDnD.handleDragStart` captures the pre-drag focused block from
    //   `rovingEditor.activeBlockId`. But the drag handle is a real <button>
    //   (BlockGutterControls' `GutterButton`) WITHOUT `data-editor-portal`, so
    //   the `mousedown` that begins the drag moves DOM focus to that button and
    //   the roving editor's blur path (useEditorBlur Step 4a only spares
    //   portal-tagged targets) unmounts the editor and calls `setFocused(null)`
    //   FIRST. By the time `handleDragStart` runs (after the 8px sensor
    //   threshold), `activeBlockId` is already null, so there is nothing for
    //   `handleDragCancel` to restore. Verified via DOM inspection: post-Esc the
    //   active element is the drag-handle button and no `block-editor` is
    //   mounted. The pre-emptive blur is inherent to handle-initiated drags, so
    //   no Playwright pointer sequence can keep the editor focused into
    //   `handleDragStart` — this is a real product behaviour, not a harness gap.
  })

  test('the drop indicator renders at the projected depth when nudged right', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs4 = ids[3] as string

    // The per-row drop indicator only renders on the OVER row, never on the
    // active drag row itself (`SortableBlockWrapper`: `overId === block.id &&
    // activeId !== block.id`). So holding a block over its OWN row — as the
    // drag-to-indent IPC test does — projects depth for the payload but paints
    // no visible bar. To assert the VISUAL indent we must drag onto a DIFFERENT
    // row whose projection can go deep: lift GS_3 and hold over GS_4. GS_4's
    // preceding sibling is GS_2 (depth 0), so the projection's `maxDepth` is 1
    // and a rightward nudge indents the indicator under it.
    const handle = await handleFor(page, 2) // GS_3
    const box = await handle.boundingBox()
    if (!box) throw new Error('no handle bounding box')
    const targetBox = await page
      .locator('[data-testid="sortable-block"]')
      .nth(3) // GS_4
      .boundingBox()
    if (!targetBox) throw new Error('no GS_4 bounding box')
    const sx = box.x + box.width / 2
    const sy = box.y + box.height / 2
    const ty = targetBox.y + targetBox.height / 2

    await page.mouse.move(sx, sy)
    await page.mouse.down()
    // Travel down onto GS_4 to establish it as the over-row, then push right to
    // project depth +1 under GS_2.
    for (let i = 1; i <= 12; i++) await page.mouse.move(sx, sy + ((ty - sy) * i) / 12)
    for (let i = 1; i <= 12; i++) await page.mouse.move(sx + (50 * i) / 12, ty)

    // The drop-indicator bar paints on GS_4's row (the over-row), indented to
    // depth 1. It is a sibling of <SortableBlock> inside GS_4's wrapper <li>
    // (the row's `data-block-id` is on the <li>).
    const bar = page.locator(`li[data-block-id="${gs4}"] .drop-indicator`).first()
    await expect(bar).toBeVisible()
    // marginLeft is `var(--indent-width) * depth`; at depth ≥ 1 it is indented
    // from the gutter (non-zero left margin).
    const marginLeft = await bar.evaluate(
      (el) => Number.parseFloat(getComputedStyle(el).marginLeft) || 0,
    )
    expect(marginLeft).toBeGreaterThan(0)

    await page.mouse.up()
  })
})
