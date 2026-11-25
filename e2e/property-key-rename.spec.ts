import type { Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  navigateToView,
  openPropertySheet,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

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
    const row = panel(page).getByRole('button', { name: 'Edit property context', exact: true })
    // Closing the sheet puts focus back on the row that opened it.
    await row.click()
    await expect(activeDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()

    const sheet = await openPropertySheet(page, 'context')
    await sheet.getByRole('textbox', { name: 'Name' }).fill('setting')
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(panel(page).getByTestId('property-usage-setting')).toHaveText('2 uses')

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(panel(page).getByTestId('property-usage-setting')).toHaveText('2 uses')
    await expect(panel(page).getByTestId('property-usage-context')).toHaveCount(0)
  })

  test('a merge moves the values into the picked definition', async ({ page }) => {
    await openProperties(page)
    const sheet = await openPropertySheet(page, 'context')
    await sheet.getByRole('button', { name: 'Merge into another property…' }).click()
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
