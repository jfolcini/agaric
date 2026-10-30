import type { Page } from '@playwright/test'

import { activeDialog, expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * #5841 S3 — Settings › Properties changes a key's type on every block of the
 * space that holds it. The seeded Personal space declares `context` as text,
 * held by two meeting blocks as `@office` and `@remote`, neither a number. The
 * change is read back after leaving Settings and coming back.
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

function contextRow(page: Page) {
  return panel(page).locator('ul > li', { hasText: 'Context' })
}

/** Change `context` to number, past the dialog that lists the two values it removes. */
async function changeToNumber(page: Page): Promise<void> {
  await openProperties(page)
  await contextRow(page).getByRole('button', { name: 'Change the type of context' }).click()
  const dialog = activeDialog(page)
  await dialog.getByRole('combobox', { name: 'New type' }).click()
  await page.getByRole('option', { name: 'number', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: 'Removed (2)' })).toBeVisible()
  await expect(dialog.getByRole('tabpanel').getByRole('listitem')).toHaveCount(2)
  await expect(dialog.getByRole('tabpanel')).toContainText('@office')
  await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
  await expect(activeDialog(page)).toHaveCount(0)
}

test.describe('Change a property type @settings', () => {
  test('a change to number removes the values that are not numbers', async ({ page }) => {
    await changeToNumber(page)

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(contextRow(page).getByText('number', { exact: true })).toBeVisible()
    await expect(panel(page).getByTestId('property-usage-context')).toHaveText('0 uses')
  })

  test("the toast's Undo brings the type and the values back", async ({ page }) => {
    await changeToNumber(page)
    await page
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(contextRow(page).getByText('text', { exact: true })).toBeVisible()
    await expect(panel(page).getByTestId('property-usage-context')).toHaveText('2 uses')
  })
})
