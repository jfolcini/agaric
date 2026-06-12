import { blurEditors, expect, focusBlock, openPage, reopenPage, test, waitForBoot } from './helpers'

// TEST-1a: block-level undo/redo tests mutate shared mock op-log state
// within a describe, so run them serially to avoid cross-test interference
// even under fullyParallel.
test.describe.configure({ mode: 'serial' })

/**
 * E2E tests for block-level undo/redo (#136).
 *
 * Block-level undo (Ctrl+Z when NOT inside contentEditable) calls
 * undoPageOp via the useUndoShortcuts hook. The mock reverses the
 * last operation. Since the frontend doesn't auto-refresh blocks
 * after undo, we navigate away and back to trigger a re-fetch from
 * the mock's updated state.
 *
 * Seed data: see tauri-mock.ts SEED_IDS.
 */

test.describe('Block-level undo/redo', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('undo reverses block creation', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore + 1)

    // Escape out of the editor so Ctrl+Z hits useUndoShortcuts
    await blurEditors(page)

    // Press Ctrl+Z — triggers block-level undo (useUndoShortcuts)
    await page.keyboard.press('Control+z')

    // Wait for the "Undone" toast to confirm undo fired
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()

    // Navigate away and back to re-fetch blocks from mock's updated state
    await reopenPage(page, 'Getting Started')

    // Block count should be back to original
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('undo reverses block deletion', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block via hover button
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Verify block was deleted
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 1)

    // Escape and blur out of any contentEditable
    await blurEditors(page)

    // Press Ctrl+Z — triggers block-level undo
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()

    // Navigate away and back to re-fetch from mock
    await reopenPage(page, 'Getting Started')

    // Block count should be restored
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('redo re-applies after undo', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore + 1)

    // Escape and blur out of any contentEditable
    await blurEditors(page)

    // Press Ctrl+Z — triggers undo
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()

    // Now redo with Ctrl+Y
    await page.keyboard.press('Control+y')
    await expect(page.getByLabel('Notifications alt+T').getByText('Redone')).toBeVisible()

    // Navigate away and back to verify
    await reopenPage(page, 'Getting Started')

    // Block should be back (countBefore + 1)
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore + 1)
  })

  // ===========================================================================
  // Structural undo/redo (#922 f5).
  //
  // The three tests above cover block CREATE / DELETE only — flat-list ops
  // whose visible effect is a count change. They also lean on the
  // navigate-away-and-back `reopenPage` re-fetch to observe the post-undo
  // state.
  //
  // These tests cover the STRUCTURAL ops (indent / dedent / move) and, per
  // the finding, assert the block returns to its original depth/order
  // *IN PLACE* — without reopening — which is what exercises the
  // `refreshAfterUndoRedo` reload path in `useUndoShortcuts`: after Ctrl+Z
  // the hook calls `pageBlockRegistry.get(pageId).load()`, re-projecting the
  // current tree into the live store so the DOM updates without a view swap.
  //
  // Indent / dedent / move all emit a `move_block` op (the indent shortcut
  // re-parents the block under its previous sibling), so the undo path is the
  // same `move_block` reversal for all three. We assert on the structural
  // signal (paddingLeft for depth, `data-block-id` order for moves) rather
  // than the toast, because the generic "Undone"/"Redone" fallback fires for
  // every op type here (the mock returns `new_op_type`, not the
  // `reversed_op_type` the per-op i18n key reads).
  //
  // Redo uses Ctrl+Shift+Z (one of the two `redoLastUndoneOp` bindings, the
  // other being Ctrl+Y used by the create test above) to cover that chord too.
  // ===========================================================================

  test('undo/redo an indent reverts depth in place (no reopen)', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_3 (index 2) is plain text — avoids the link chips in GS_2.
    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const basePadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Indent GS_3 under GS_2 via the documented Ctrl+Shift+ArrowRight shortcut.
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Confirm the indent applied (paddingLeft grew).
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBeGreaterThan(basePadding)
    const indentedPadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Escape out of the editor so Ctrl+Z hits useUndoShortcuts (not ProseMirror).
    await blurEditors(page)

    // Ctrl+Z — block-level undo. Reverses the move_block op AND, crucially,
    // calls refreshAfterUndoRedo → the store reloads and the depth reverts
    // IN PLACE with no navigation.
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()

    // WITHOUT reopening: the block must be back at its original depth.
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(basePadding)

    // Ctrl+Shift+Z — redo re-applies the indent, again in place.
    await page.keyboard.press('Control+Shift+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Redone')).toBeVisible()
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(indentedPadding)
  })

  // #958: undoing a dedent must re-nest the block to its prior depth IN PLACE
  // (no reopen). The indent here is only scaffolding to create a depth to dedent
  // FROM; it must NOT be part of the same undo group as the dedent, or the single
  // Ctrl+Z reverts BOTH (indent + dedent are both `move_block` by the same device,
  // and undo batches same-device ops within UNDO_GROUP_WINDOW_MS=500ms — see
  // undo.ts / find_undo_group). The earlier "depth stays 0" trace failure was
  // exactly that group: undo reverted the dedent AND the scaffolding indent, so
  // the block landed back at root. Waiting past the 500ms window puts the dedent
  // in its own undo group, so Ctrl+Z reverts only the dedent.
  test('undo a dedent restores the nested depth in place (no reopen)', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const basePadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // First indent GS_3 so there is a depth to dedent FROM (editor stays open).
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBeGreaterThan(basePadding)
    const indentedPadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Let the undo-group window (500ms) lapse so the scaffolding indent and the
    // dedent below are SEPARATE undo groups — otherwise one Ctrl+Z reverts both.
    await page.waitForTimeout(700)

    // Dedent it back to root (Ctrl+Shift+ArrowLeft); editor is still open.
    await page.keyboard.press('Control+Shift+ArrowLeft')
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(basePadding)

    // Escape and undo the dedent — depth must return to the INDENTED value in
    // place (the dedent was the last op; its reversal re-nests the block).
    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()

    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(indentedPadding)
  })

  // #958: a single keyboard move (Ctrl+Shift+ArrowUp) is its own undo group, so
  // Ctrl+Z reverts exactly that move in place (no reopen). Confirmed green e2e
  // after the tauri-mock move undo/redo re-slot+renumber fix (undo-move.test.ts).
  test('undo/redo a move reverts block order in place (no reopen)', async ({ page }) => {
    // Quick Notes has exactly 2 blocks — the simplest, most reliable move case.
    await openPage(page, 'Quick Notes')

    const blocks = page.locator('[data-testid="sortable-block"]')
    const originalFirstId = (await blocks.nth(0).getAttribute('data-block-id')) ?? ''
    const originalSecondId = (await blocks.nth(1).getAttribute('data-block-id')) ?? ''
    expect(originalFirstId).not.toBe('')
    expect(originalSecondId).not.toBe('')

    // Move the second block up (Ctrl+Shift+ArrowUp) so the order swaps.
    await focusBlock(page, 1)
    await page.keyboard.press('Control+Shift+ArrowUp')

    // Escape so the move settles and the next Ctrl+Z hits useUndoShortcuts.
    await blurEditors(page)

    // The previously-second block is now first.
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })

    // Ctrl+Z — undo the move. Order must revert IN PLACE (no reopen): the
    // original first block is first again.
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Undone')).toBeVisible()
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalFirstId, {
      timeout: 5000,
    })

    // Ctrl+Shift+Z — redo re-applies the move, again in place.
    await page.keyboard.press('Control+Shift+z')
    await expect(page.getByLabel('Notifications alt+T').getByText('Redone')).toBeVisible()
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })
  })
})
