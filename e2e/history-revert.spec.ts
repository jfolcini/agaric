import { expect, test } from '@playwright/test'

/**
 * E2E tests for HistoryView batch revert (#137).
 *
 * Tests the full flow: perform mutations -> navigate to History ->
 * select entries -> confirm revert -> verify state changed.
 *
 * The tauri-mock tracks an op log and supports batch revert.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

async function openPage(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

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
    await expect(page.locator('.sortable-block').last()).toBeVisible({ timeout: 3000 })

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
    await expect(page.locator('.sortable-block').last()).toBeVisible({ timeout: 3000 })

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Click the first history item checkbox to select it
    const firstItem = page.locator('[data-history-item]').first()
    const checkbox = firstItem.locator('input[type="checkbox"]')
    await checkbox.click()

    // Selection toolbar should appear with "Revert selected"
    await expect(page.getByText('1 selected')).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole('button', { name: /Revert selected/i })).toBeVisible()

    // Click "Revert selected" to trigger confirmation dialog
    await page.getByRole('button', { name: /Revert selected/i }).click()

    // Confirmation dialog should appear
    await expect(page.getByText(/Revert 1 operation/i)).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  test('batch revert reverses a create_block operation', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore + 1, {
      timeout: 3000,
    })

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Find and select the create_block entry (most recent is first)
    const createEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('.history-item-type', { hasText: 'create_block' }),
      })
      .first()
    await expect(createEntry).toBeVisible({ timeout: 3000 })
    const checkbox = createEntry.locator('input[type="checkbox"]')
    await checkbox.click()

    // Click "Revert selected"
    await page.getByRole('button', { name: /Revert selected/i }).click()

    // Confirm revert
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Revert' }).click()

    // Selection should be cleared after revert
    await expect(page.getByText(/selected/)).not.toBeVisible({ timeout: 3000 })

    // Navigate back to the page and verify block is gone
    await openPage(page, 'Getting Started')
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore, {
      timeout: 3000,
    })
  })

  test('batch revert restores a deleted block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible({ timeout: 3000 })
    await deleteBtn.click()
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore - 1, {
      timeout: 3000,
    })

    // Navigate to History
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Find and select the delete_block entry
    const deleteEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('.history-item-type', { hasText: 'delete_block' }),
      })
      .first()
    await expect(deleteEntry).toBeVisible({ timeout: 3000 })
    await deleteEntry.locator('input[type="checkbox"]').click()

    // Revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Revert' })).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Revert' }).click()
    await expect(page.getByText(/selected/)).not.toBeVisible({ timeout: 3000 })

    // Navigate back and verify block is restored
    await openPage(page, 'Getting Started')
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore, {
      timeout: 3000,
    })
  })

  test('cancel in confirmation dialog does not revert', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await page.waitForTimeout(300)

    // Navigate to History and select
    await page.getByRole('button', { name: 'History' }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })
    await page.locator('[data-history-item]').first().locator('input[type="checkbox"]').click()

    // Click revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 3000 })

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Selection should still be active
    await expect(page.getByText('1 selected')).toBeVisible({ timeout: 3000 })
  })
})
