import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for batch block operations (TEST-14).
 *
 * Tests multi-select via Ctrl+Click, batch toolbar visibility,
 * bulk TODO state changes, and Ctrl+A select-all functionality.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *
 * Selection mechanics:
 *   - Ctrl+Click on a static block toggles it in/out of selection
 *   - Selected blocks get `ring-2 ring-primary/50 bg-primary/5` on [data-testid="block-static"]
 *   - Batch toolbar (`.batch-toolbar`) appears when selectedBlockIds.length > 0
 *   - Ctrl+A selects all blocks (only when no block is focused/editing)
 */

test.describe('Batch block operations', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    // Verify seed blocks are loaded
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  // =========================================================================
  // 1. Multi-select blocks via Ctrl+Click
  // =========================================================================

  test('multi-select blocks via Ctrl+Click shows selection indicator on both blocks', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const firstStatic = blocks.nth(0).locator('[data-testid="block-static"]')
    const secondStatic = blocks.nth(1).locator('[data-testid="block-static"]')

    // Initially, blocks should NOT have the selection highlight
    await expect(firstStatic).not.toHaveClass(/bg-primary/)
    await expect(secondStatic).not.toHaveClass(/bg-primary/)

    // Ctrl+Click first block to toggle it into selection
    await firstStatic.click({ modifiers: ['Control'] })
    await expect(firstStatic).toHaveClass(/bg-primary/)

    // Ctrl+Click second block to add it to selection
    await secondStatic.click({ modifiers: ['Control'] })
    await expect(firstStatic).toHaveClass(/bg-primary/)
    await expect(secondStatic).toHaveClass(/bg-primary/)
  })

  // =========================================================================
  // 2. Batch toolbar appears with selection count
  // =========================================================================

  test('batch toolbar appears with correct selection count after multi-select', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // No batch toolbar initially
    await expect(batchToolbar).not.toBeVisible()

    // Ctrl+Click first block
    await blocks
      .nth(0)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'] })

    // Toolbar appears with count 1
    await expect(batchToolbar).toBeVisible()
    await expect(batchToolbar).toContainText('1')
    await expect(batchToolbar).toContainText('selected')

    // Ctrl+Click second block — count becomes 2
    await blocks
      .nth(1)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'] })
    await expect(batchToolbar).toContainText('2')
    await expect(batchToolbar).toContainText('selected')
  })

  // =========================================================================
  // 3. Bulk TODO state change via batch toolbar
  // =========================================================================

  test('bulk TODO state change sets TODO on all selected blocks', async ({ page }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // Select two blocks via Ctrl+Click
    await blocks
      .nth(0)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'] })
    await blocks
      .nth(1)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'] })
    await expect(batchToolbar).toBeVisible()

    // Click TODO button in the batch toolbar
    await batchToolbar.getByRole('button', { name: 'TODO' }).click()

    // Both blocks should now show the TODO checkbox indicator
    await expect(blocks.nth(0).locator('[data-testid="task-checkbox-todo"]')).toBeVisible()
    await expect(blocks.nth(1).locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // Selection should be cleared after batch operation (toolbar disappears)
    await expect(batchToolbar).not.toBeVisible()
  })

  // =========================================================================
  // 4. Ctrl+A selects all blocks
  // =========================================================================

  test('Ctrl+A selects all blocks when no block is focused', async ({ page }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const blockCount = await blocks.count()
    expect(blockCount).toBe(5)

    const batchToolbar = page.getByTestId('batch-toolbar')

    // No toolbar initially
    await expect(batchToolbar).not.toBeVisible()

    // Press Ctrl+A — should select all blocks (no block is in edit mode)
    await page.keyboard.press('Control+a')

    // Batch toolbar appears with total count
    await expect(batchToolbar).toBeVisible()
    await expect(batchToolbar).toContainText(`${blockCount}`)
    await expect(batchToolbar).toContainText('selected')

    // All static blocks should have the selection highlight indicator
    for (let i = 0; i < blockCount; i++) {
      await expect(blocks.nth(i).locator('[data-testid="block-static"]')).toHaveClass(/bg-primary/)
    }
  })
})
