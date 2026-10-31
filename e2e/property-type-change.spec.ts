import type { Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5841 S3 — Settings › Properties changes a key's type on every block of the
 * space that holds it. The seeded Personal space declares `context` as text,
 * held by two meeting blocks as `@office` and `@remote`, neither a number nor
 * a date. A value the new type can't hold is kept as text (#6206). The change
 * is read back after leaving the view and coming back.
 */

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

async function openProperties(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
}

/** Open `context`'s type dialog and pick `type`. */
async function pickContextType(page: Page, type: string) {
  await openProperties(page)
  await contextRow(page).getByRole('button', { name: 'Change the type of context' }).click()
  const dialog = activeDialog(page)
  await dialog.getByRole('combobox', { name: 'New type' }).click()
  await page.getByRole('option', { name: type, exact: true }).click()
  return dialog
}

function panel(page: Page) {
  return page.locator('[data-testid="settings-panel-properties"]')
}

const MEETINGS = '00000000000000000000PAGE05'

function contextRow(page: Page) {
  return panel(page).locator('ul > li', { hasText: 'Context' })
}

/** Change `context` to number, past the dialog that lists the two values that don't fit. */
async function changeToNumber(page: Page): Promise<void> {
  const dialog = await pickContextType(page, 'number')
  await expect(dialog.getByRole('tab', { name: "Don't fit (2)" })).toBeVisible()
  await expect(dialog.getByRole('tabpanel').getByRole('listitem')).toHaveCount(2)
  await expect(dialog.getByRole('tabpanel')).toContainText('@office')
  await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
  await expect(activeDialog(page)).toHaveCount(0)
}

test.describe('Change a property type @settings', () => {
  test('a change to number keeps the values that are not numbers', async ({ page }) => {
    await changeToNumber(page)

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(contextRow(page).getByText('number', { exact: true })).toBeVisible()
    await expect(panel(page).getByTestId('property-usage-context')).toHaveText('2 uses')
  })

  test('a change to date keeps a value that is not a date on its block, as text', async ({
    page,
  }) => {
    await seedSearchBlocks(page, [
      { content: 'Retype holder', parentId: MEETINGS, props: { context: 'soon' } },
    ])
    const dialog = await pickContextType(page, 'date')
    await expect(dialog.getByRole('tab', { name: "Don't fit (3)", selected: true })).toBeVisible()
    const holder = dialog
      .getByRole('tabpanel')
      .getByRole('listitem')
      .filter({ hasText: 'Retype holder' })
    await expect(holder).toContainText('soon')
    await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
    await expect(activeDialog(page)).toHaveCount(0)

    await openPage(page, 'Meetings')
    const chips = page
      .locator('[data-testid="sortable-block"]', { hasText: 'Retype holder' })
      .locator('[data-testid="property-chip"]')
    await expect(chips).toHaveText(['Context:soon'])
    await reopenPage(page, 'Meetings')
    await expect(chips).toHaveText(['Context:soon'])
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
