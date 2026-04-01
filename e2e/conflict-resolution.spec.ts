import { expect, test } from '@playwright/test'

async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible({ timeout: 5000 })
}

test.describe('Conflict resolution', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Conflicts view shows conflict items', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('header').getByText('Conflicts')).toBeVisible()

    // Should show at least 1 conflict item (seeded in tauri-mock)
    await expect(page.locator('.conflict-item').first()).toBeVisible({ timeout: 3000 })
  })

  test('Keep button applies conflict content and removes item', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible({ timeout: 3000 })

    const countBefore = await page.locator('.conflict-item').count()

    // Click Keep on first conflict
    await page.locator('.conflict-keep-btn').first().click()

    // Conflict should be removed from list
    if (countBefore === 1) {
      await expect(page.locator('.conflict-item')).toHaveCount(0, { timeout: 3000 })
    } else {
      await expect(page.locator('.conflict-item')).toHaveCount(countBefore - 1, { timeout: 3000 })
    }
  })

  test('Discard requires confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible({ timeout: 3000 })

    // Click Discard — should show confirmation prompt, not remove item
    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible({ timeout: 3000 })
  })

  test('Discard No dismisses confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible({ timeout: 3000 })

    const countBefore = await page.locator('.conflict-item').count()

    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible({ timeout: 3000 })

    // Click No — confirmation should disappear, item count unchanged
    await page.locator('.conflict-discard-no').click()
    await expect(page.locator('.conflict-discard-confirm')).not.toBeVisible({ timeout: 3000 })
    await expect(page.locator('.conflict-item')).toHaveCount(countBefore, { timeout: 3000 })
  })

  test('Discard Yes removes conflict permanently', async ({ page }) => {
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('.conflict-item').first()).toBeVisible({ timeout: 3000 })

    const countBefore = await page.locator('.conflict-item').count()

    await page.locator('.conflict-discard-btn').first().click()
    await expect(page.locator('.conflict-discard-confirm')).toBeVisible({ timeout: 3000 })

    // Click Yes — item should be removed
    await page.locator('.conflict-discard-yes').click()

    if (countBefore === 1) {
      await expect(page.locator('.conflict-item')).toHaveCount(0, { timeout: 3000 })
    } else {
      await expect(page.locator('.conflict-item')).toHaveCount(countBefore - 1, { timeout: 3000 })
    }
  })
})
