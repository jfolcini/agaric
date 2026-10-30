import type { Page } from '@playwright/test'

import { activeDialog, expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * #5841 S2 — Settings › Properties renames a key, and merges one key into
 * another, on every block of the space that holds it. The seeded Personal
 * space declares `context` and `reviewer` (text); `context` is on two meeting
 * blocks, `reviewer` on none. A block's values are read back through the usage
 * badge after leaving Settings and coming back.
 */

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

async function openProperties(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
}

function panel(page: Page) {
  return page.locator('[data-testid="settings-panel-properties"]')
}

test.describe('Rename and merge a property key @settings', () => {
  test('a rename moves the definition and its values to the new key', async ({ page }) => {
    await openProperties(page)
    const rename = panel(page).getByRole('button', { name: 'Rename property context' })
    // Closing the dialog puts focus back on the button that opened it.
    await rename.click()
    await expect(activeDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rename).toBeFocused()

    await rename.click()
    const dialog = activeDialog(page)
    await dialog.getByRole('textbox', { name: 'New property key' }).fill('setting')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(panel(page).getByTestId('property-usage-setting')).toHaveText('2 uses')

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(panel(page).getByTestId('property-usage-setting')).toHaveText('2 uses')
    await expect(panel(page).getByTestId('property-usage-context')).toHaveCount(0)
  })

  test('a merge moves the values into the picked definition', async ({ page }) => {
    await openProperties(page)
    await panel(page).getByRole('button', { name: 'Merge context into…' }).click()
    const dialog = activeDialog(page)
    await dialog.getByRole('combobox', { name: 'Property to merge into' }).click()
    await page.getByRole('option', { name: 'reviewer', exact: true }).click()
    await expect(dialog.getByText('2 values move to reviewer.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(panel(page).getByTestId('property-usage-reviewer')).toHaveText('2 uses')

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(panel(page).getByTestId('property-usage-reviewer')).toHaveText('2 uses')
    await expect(panel(page).getByTestId('property-usage-context')).toHaveCount(0)
  })
})
