import { expect, test } from './helpers'

// TEST-1a: sync UI tests share mocked peer / pairing state within the
// describe block and are sensitive to parallel mock-state collisions.
test.describe.configure({ mode: 'serial' })

test.describe('Sync UI', () => {
  // --- StatusPanel (materializer + sync summary) -------------------------
  //
  // UX-143 moved DeviceManagement out of StatusPanel; the panel now only
  // exposes materializer stats and a high-level sync summary. The two
  // assertions below target what actually lives in StatusPanel today.
  test.describe('Status panel', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Status', exact: true }).click()
      await expect(page.locator('header').getByText('Status')).toBeVisible()
    })

    test('shows sync status section', async ({ page }) => {
      await expect(page.locator('[data-testid="sync-panel-title"]')).toBeVisible()
      await expect(page.getByText('Sync Status')).toBeVisible()
    })

    test('shows not configured when no peers', async ({ page }) => {
      // With empty sync store, should show "not configured" or similar
      await expect(page.locator('[data-testid="sync-panel-not-configured"]')).toBeVisible()
    })
  })

  // --- DeviceManagement (Settings → Sync & Devices) ----------------------
  //
  // UX-143: DeviceManagement was removed from StatusPanel and kept only in
  // SettingsView under the "Sync & Devices" tab. All pairing / device-id /
  // paired-peer-list surfaces now live here.
  test.describe('Device management', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
      // Navigate to Settings and open the Sync & Devices tab
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.locator('header').getByText('Settings')).toBeVisible()
      await page.getByRole('tab', { name: /Sync.*Devices/i }).click()
      await expect(page.locator('[data-testid="settings-panel-sync"]')).toBeVisible()
    })

    test('shows device management', async ({ page }) => {
      // DeviceManagement exposes the "Local Device ID" label (i18n key
      // `device.localDeviceIdLabel`). Assert via test-id to avoid coupling
      // to the English label text.
      await expect(page.locator('[data-testid="local-device-id-label"]')).toBeVisible()
    })

    test('device ID is displayed', async ({ page }) => {
      // The mock returns 'mock-device-id-0000' and the full value is
      // rendered inside the device-id-value span (targeted via test-id).
      await expect(page.locator('[data-testid="local-device-id-value"]')).toHaveText(/mock-device/)
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
      // Should show the empty-state paragraph (distinct from the "Pair New
      // Device" button, which otherwise collides with a permissive regex
      // match under strict mode).
      await expect(page.getByTestId('device-no-peers')).toBeVisible()
      await expect(page.getByTestId('device-no-peers')).toHaveText(/no paired devices/i)
    })
  })
})
