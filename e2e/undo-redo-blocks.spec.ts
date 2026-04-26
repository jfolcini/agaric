import { blurEditors, expect, openPage, reopenPage, test, waitForBoot } from './helpers'

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
})
