import { expect, test } from '@playwright/test'
import { openPage, waitForBoot } from './helpers'

/**
 * E2E tests for HistoryView batch revert (#137).
 *
 * Tests the full flow: perform mutations -> navigate to History ->
 * select entries -> confirm revert -> verify state changed.
 *
 * The tauri-mock tracks an op log and supports batch revert.
 */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('HistoryView batch revert', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('history view shows operation entries after mutations', async ({ page }) => {
    // Perform some mutations first
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    // Navigate to History view
    await page.getByRole('button', { name: 'History' }).click()

    // Verify history entries appear (op log should have create_block op at minimum)
    const historyItems = page.locator('[data-history-item]')
    await expect(historyItems.first()).toBeVisible({ timeout: 5000 })
    const count = await historyItems.count()
    expect(count).toBeGreaterThan(0)
  })

  test('selecting and reverting operations shows confirmation dialog', async ({ page }) => {
    // Create a block to generate an op
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Click the first history item checkbox to select it
    const firstItem = page.locator('[data-history-item]').first()
    const checkbox = firstItem.locator('input[type="checkbox"]')
    await checkbox.click()

    // Selection toolbar should appear with "Revert selected"
    await expect(page.getByText('1 selected')).toBeVisible()
    await expect(page.getByRole('button', { name: /Revert selected/i })).toBeVisible()

    // Click "Revert selected" to trigger confirmation dialog
    await page.getByRole('button', { name: /Revert selected/i }).click()

    // Confirmation dialog should appear
    await expect(page.getByText(/Revert 1 operation/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  test('batch revert reverses a create_block operation', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore + 1)

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Find and select the create_block entry (most recent is first)
    const createEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-item-type"]', { hasText: 'create_block' }),
      })
      .first()
    await expect(createEntry).toBeVisible()
    const checkbox = createEntry.locator('input[type="checkbox"]')
    await checkbox.click()

    // Click "Revert selected"
    await page.getByRole('button', { name: /Revert selected/i }).click()

    // Confirm revert
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible()
    await page.getByRole('button', { name: 'Revert' }).click()

    // Selection should be cleared after revert
    await expect(page.getByText(/selected/)).not.toBeVisible()

    // Navigate back to the page and verify block is gone
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('batch revert restores a deleted block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 1)

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Find and select the delete_block entry
    const deleteEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-type-badge"]', { hasText: 'delete_block' }),
      })
      .first()
    await expect(deleteEntry).toBeVisible()
    await deleteEntry.locator('input[type="checkbox"]').click()

    // Revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible()
    await page.getByRole('button', { name: 'Revert' }).click()
    await expect(page.getByText(/selected/)).not.toBeVisible()

    // Navigate back and verify block is restored
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('cancel in confirmation dialog does not revert', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const blocksBefore = await page.locator('[data-testid="sortable-block"]').count()
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(blocksBefore + 1)

    // Navigate to History and select
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })
    await page.locator('[data-history-item]').first().locator('input[type="checkbox"]').click()

    // Click revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Selection should still be active
    await expect(page.getByText('1 selected')).toBeVisible()
  })
})
