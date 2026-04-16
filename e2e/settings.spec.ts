import { expect, test } from '@playwright/test'

test.describe('Settings panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for app to boot
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
    // Navigate to Settings
    await page.getByRole('button', { name: 'Settings' }).click()
  })

  test('Settings view opens from sidebar', async ({ page }) => {
    // Tab bar should be visible
    await expect(page.getByRole('tablist')).toBeVisible()
  })

  test('All 6 tabs are visible and clickable', async ({ page }) => {
    const tabNames = ['General', 'Properties', 'Appearance', 'Keyboard', 'Data', 'Sync & Devices']
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name })
      await expect(tab).toBeVisible()
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
  })

  test('General tab is selected by default', async ({ page }) => {
    const generalTab = page.getByRole('tab', { name: 'General' })
    await expect(generalTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="settings-panel-general"]')).toBeVisible()
  })

  test('Theme selector shows options', async ({ page }) => {
    await page.getByRole('tab', { name: 'Appearance' }).click()
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).toBeVisible()

    // Find and open the theme Select trigger
    const themeTrigger = page.getByRole('combobox', { name: 'Theme' })
    await expect(themeTrigger).toBeVisible()
    await themeTrigger.click()

    // Verify the three options appear
    await expect(page.getByRole('option', { name: 'Light' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Dark' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'System' })).toBeVisible()
  })

  test('Keyboard settings tab renders shortcut list', async ({ page }) => {
    await page.getByRole('tab', { name: 'Keyboard' }).click()
    await expect(page.locator('[data-testid="settings-panel-keyboard"]')).toBeVisible()
    await expect(page.locator('[data-testid="keyboard-settings-tab"]')).toBeVisible()

    // Should show the title and at least one kbd element (shortcut key)
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
    await expect(page.locator('kbd').first()).toBeVisible()
  })

  test('Data settings tab renders controls', async ({ page }) => {
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('[data-testid="settings-panel-data"]')).toBeVisible()

    // Import and Export panels should be visible
    await expect(page.locator('[data-testid="import-panel-title"]')).toBeVisible()
    await expect(page.locator('[data-testid="export-panel-title"]')).toBeVisible()
  })

  test('Navigate away and back resets to default tab', async ({ page }) => {
    // Switch to Appearance tab
    await page.getByRole('tab', { name: 'Appearance' }).click()
    await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Navigate away to Journal
    await page.getByRole('button', { name: 'Journal' }).click()
    // Wait until we're on the Journal view (Settings panel is gone)
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).not.toBeVisible()

    // Navigate back to Settings
    await page.getByRole('button', { name: 'Settings' }).click()

    // General tab is selected by default (component remounts, state resets)
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-general"]')).toBeVisible()
  })
})
