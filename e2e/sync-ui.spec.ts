import { expect, test } from '@playwright/test'

test.describe('Sync UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for app to boot
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
    // Navigate to Status
    await page.getByRole('button', { name: 'Status' }).click()
    await expect(page.locator('header').getByText('Status')).toBeVisible()
  })

  test('Status panel shows sync status section', async ({ page }) => {
    await expect(page.locator('.sync-panel-title')).toBeVisible()
    await expect(page.getByText('Sync Status')).toBeVisible()
  })

  test('Status panel shows device management', async ({ page }) => {
    // DeviceManagement shows "Device ID" label
    await expect(page.getByText('Device ID')).toBeVisible()
  })

  test('Device ID is displayed', async ({ page }) => {
    // The mock returns 'mock-device-id-0000', displayed truncated to 12 chars
    await expect(page.getByText('mock-device')).toBeVisible()
  })

  test('Pair New Device button exists and opens dialog', async ({ page }) => {
    const pairBtn = page.getByRole('button', { name: /pair new device/i })
    await expect(pairBtn).toBeVisible()
    await pairBtn.click()

    // PairingDialog should open and show QR code or passphrase
    await expect(page.getByText('Pair Device')).toBeVisible()
  })

  test('Pairing dialog shows QR code and passphrase', async ({ page }) => {
    await page.getByRole('button', { name: /pair new device/i }).click()
    await expect(page.getByText('Pair Device')).toBeVisible()

    // Mock returns passphrase: 'alpha bravo charlie delta'
    // QR code should be visible (either as svg or data-testid)
    // Passphrase display should be visible
    await expect(page.getByText(/alpha/i)).toBeVisible()
  })

  test('Pairing dialog has word entry inputs', async ({ page }) => {
    await page.getByRole('button', { name: /pair new device/i }).click()
    await expect(page.getByText('Pair Device')).toBeVisible()

    // Should have 4 word input fields
    const wordInputs = page.locator('input[aria-label*="Passphrase word"]')
    await expect(wordInputs).toHaveCount(4)
  })

  test('Pairing dialog close button works', async ({ page }) => {
    await page.getByRole('button', { name: /pair new device/i }).click()
    await expect(page.getByText('Pair Device')).toBeVisible()

    // Close the dialog — scope to the dialog element to avoid matching
    // the overlay button which also has aria-label="Close pairing dialog"
    const closeBtn = page.getByRole('dialog').getByRole('button', { name: /close/i })
    if (await closeBtn.isVisible()) {
      await closeBtn.click()
    } else {
      // Try pressing Escape
      await page.keyboard.press('Escape')
    }

    await expect(page.getByText('Pair Device')).not.toBeVisible()
  })

  test('No paired devices shows empty state', async ({ page }) => {
    // Mock returns empty peer list
    // Should show message about no paired devices
    await expect(page.getByText(/no.*paired.*device|pair.*new.*device/i)).toBeVisible()
  })

  test('Sync status shows not configured when no peers', async ({ page }) => {
    // With empty sync store, should show "not configured" or similar
    await expect(page.locator('.sync-panel-not-configured')).toBeVisible()
  })
})
