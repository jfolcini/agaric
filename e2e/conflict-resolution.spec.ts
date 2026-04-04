import { expect, test } from '@playwright/test'
import { waitForBoot } from './helpers'

test.describe('Conflict resolution', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Conflicts view shows conflict items', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('header').getByText('Conflicts')).toBeVisible()

    // Should show at least 1 conflict item (seeded in tauri-mock)
    await expect(page.locator('.conflict-item').first()).toBeVisible()
  })

  test('Keep button applies conflict content and removes item', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible()

    const countBefore = await page.locator('.conflict-item').count()

    // Click Keep on first conflict
    await page.locator('.conflict-keep-btn').first().click()

    // Conflict should be removed from list
    if (countBefore === 1) {
      await expect(page.locator('.conflict-item')).toHaveCount(0)
    } else {
      await expect(page.locator('.conflict-item')).toHaveCount(countBefore - 1)
    }
  })

  test('Discard requires confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible()

    // Click Discard — should show confirmation prompt, not remove item
    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible()
  })

  test('Discard No dismisses confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible()

    const countBefore = await page.locator('.conflict-item').count()

    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible()

    // Click No — confirmation should disappear, item count unchanged
    await page.locator('.conflict-discard-no').click()
    await expect(page.locator('.conflict-discard-confirm')).not.toBeVisible()
    await expect(page.locator('.conflict-item')).toHaveCount(countBefore)
  })

  test('Discard Yes removes conflict permanently', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible()

    const countBefore = await page.locator('.conflict-item').count()

    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible()

    // Click Yes — item should be removed
    await page.locator('.conflict-discard-yes').click()

    if (countBefore === 1) {
      await expect(page.locator('.conflict-item')).toHaveCount(0)
    } else {
      await expect(page.locator('.conflict-item')).toHaveCount(countBefore - 1)
    }
  })
})
