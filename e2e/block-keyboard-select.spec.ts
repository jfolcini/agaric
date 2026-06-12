import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for keyboard multi-block selection (#922, finding 1).
 *
 * Block multi-selection used to be mouse-only (Ctrl+Click / Shift+Click).
 * This spec exercises the keyboard chord that extends a contiguous selection
 * from a block-select (non-editing) state:
 *   - Shift+ArrowDown extends the selection downward by one visible block
 *   - Shift+ArrowUp extends upward
 * The selection it builds is the same `selectedBlockIds` the batch toolbar
 * and the Ctrl/Shift+Click chords drive, so the toolbar lights up with the
 * count automatically.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks GS_1..GS_5.
 *
 * Selection mechanics (mirrors batch-operations.spec.ts):
 *   - Selected blocks get the `block-selected` utility on
 *     [data-testid="block-static"].
 *   - Batch toolbar (`.batch-toolbar`, testid `batch-toolbar`) shows when
 *     selectedBlockIds.length > 0, with the count.
 *   - Entry into block-select mode: Ctrl+Click a static block selects it
 *     (single selection, no editor focused) — the anchor for Shift+Arrow.
 */

test.describe('Keyboard block multi-selection (#922)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('Shift+ArrowDown extends a contiguous selection and drives the batch toolbar', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // Enter block-select mode: Ctrl+Click the first block to select it WITHOUT
    // opening its editor. This is the anchor for keyboard range extension.
    const firstStatic = blocks.nth(0).locator('[data-testid="block-static"]')
    await firstStatic.click({ modifiers: ['Control'] })
    await expect(firstStatic).toHaveClass(/block-selected/)
    await expect(batchToolbar).toBeVisible()
    await expect(batchToolbar).toContainText('1')

    // Press Shift+ArrowDown twice — extend the selection down by two blocks.
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')

    // The first three blocks now carry the selection highlight.
    for (let i = 0; i < 3; i++) {
      await expect(blocks.nth(i).locator('[data-testid="block-static"]')).toHaveClass(
        /block-selected/,
      )
    }
    // Block 4 stays unselected (the range stopped at 3).
    await expect(blocks.nth(3).locator('[data-testid="block-static"]')).not.toHaveClass(
      /block-selected/,
    )

    // The batch toolbar reflects the keyboard-built selection count.
    await expect(batchToolbar).toBeVisible()
    await expect(batchToolbar).toContainText('3')
    await expect(batchToolbar).toContainText('selected')
  })

  test('Shift+ArrowUp shrinks the selection back toward the anchor', async ({ page }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    const firstStatic = blocks.nth(0).locator('[data-testid="block-static"]')
    await firstStatic.click({ modifiers: ['Control'] })
    await expect(batchToolbar).toContainText('1')

    // Grow down to three blocks…
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(batchToolbar).toContainText('3')

    // …then Shift+ArrowUp shrinks back toward the anchor (block 1).
    await page.keyboard.press('Shift+ArrowUp')
    await expect(batchToolbar).toContainText('2')
    await expect(blocks.nth(0).locator('[data-testid="block-static"]')).toHaveClass(
      /block-selected/,
    )
    await expect(blocks.nth(1).locator('[data-testid="block-static"]')).toHaveClass(
      /block-selected/,
    )
    await expect(blocks.nth(2).locator('[data-testid="block-static"]')).not.toHaveClass(
      /block-selected/,
    )
  })
})
