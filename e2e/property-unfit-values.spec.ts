import type { Page } from '@playwright/test'

import {
  activeDialog,
  activePopover,
  expect,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6206 — Settings › Properties counts a key's values that don't fit it and
 * removes them, adds them to a select's options, or converts each to a value
 * that fits. The seeded Personal space declares `project` as a select of
 * alpha, beta and gamma, held by two meeting blocks as alpha and beta; editing
 * the options to drop beta leaves the second block's beta not fitting. Each
 * effect is read back after leaving the view and coming back.
 */

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await openProperties(page)
})

async function openProperties(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
}

function panel(page: Page) {
  return page.getByTestId('settings-panel-properties')
}

function projectRow(page: Page) {
  return panel(page)
    .getByRole('listitem')
    .filter({ has: page.getByText('Project', { exact: true }) })
}

function unfitBadge(page: Page) {
  return panel(page).getByTestId('property-unfit-project')
}

/** Drop `beta` from `project`'s options through Edit options. */
async function dropBeta(page: Page): Promise<void> {
  await projectRow(page).getByRole('button', { name: 'Edit options', exact: true }).click()
  const editor = activePopover(page)
  await editor.getByRole('button', { name: 'Remove option beta', exact: true }).click()
  await editor.getByRole('button', { name: 'Save options', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(unfitBadge(page)).toHaveText("1 doesn't fit")
}

/** Open the dialog from the badge; it lists the meeting block's beta. */
async function openUnfit(page: Page) {
  await unfitBadge(page).click()
  const dialog = activeDialog(page)
  await expect(dialog.getByText("1 value doesn't fit.")).toBeVisible()
  const beta = dialog.getByRole('listitem').filter({ hasText: 'beta' })
  await expect(beta).toContainText('Meetings ›')
  await expect(beta).toContainText('Not one of the options')
  return dialog
}

/** Convert the meeting block's beta to alpha; the badge goes. */
async function convertBetaToAlpha(page: Page): Promise<void> {
  const dialog = await openUnfit(page)
  await dialog.getByRole('button', { name: 'Convert…', exact: true }).click()
  await expect(dialog.getByText('1 block', { exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Replacement for beta', exact: true }).click()
  await page.getByRole('option', { name: 'alpha', exact: true }).click()
  await dialog.getByRole('button', { name: 'Convert 1', exact: true }).click()
  await expect(activeDialog(page)).toHaveCount(0)
  await expect(unfitBadge(page)).toHaveCount(0)
}

async function comeBack(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await openProperties(page)
  await expect(panel(page).getByTestId('property-usage-project')).toBeVisible()
}

test.describe("Values that don't fit a property @settings", () => {
  test("Remove takes them off, and the toast's Undo puts them back", async ({ page }) => {
    await dropBeta(page)
    const dialog = await openUnfit(page)
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(activeDialog(page)).toHaveCount(0)
    await expect(panel(page).getByTestId('property-usage-project')).toHaveText('1 use')
    await expect(unfitBadge(page)).toHaveCount(0)

    await page
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()
    await expect(unfitBadge(page)).toHaveText("1 doesn't fit")

    await comeBack(page)
    await expect(panel(page).getByTestId('property-usage-project')).toHaveText('2 uses')
    await expect(unfitBadge(page)).toHaveText("1 doesn't fit")
  })

  test("Convert replaces each with a value that fits, and the toast's Undo puts them back", async ({
    page,
  }) => {
    await dropBeta(page)
    await convertBetaToAlpha(page)
    await page
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()
    await expect(unfitBadge(page)).toHaveText("1 doesn't fit")
    await comeBack(page)
    await expect(unfitBadge(page)).toHaveText("1 doesn't fit")

    // Convert again, and read the conversion back after leaving the view.
    await convertBetaToAlpha(page)
    await comeBack(page)
    await expect(panel(page).getByTestId('property-usage-project')).toHaveText('2 uses')
    await expect(unfitBadge(page)).toHaveCount(0)
  })

  test('Add to options makes them fit', async ({ page }) => {
    await dropBeta(page)
    const dialog = await openUnfit(page)
    await dialog.getByRole('button', { name: 'Add to options', exact: true }).click()
    await expect(activeDialog(page)).toHaveCount(0)
    await expect(unfitBadge(page)).toHaveCount(0)

    await comeBack(page)
    await expect(unfitBadge(page)).toHaveCount(0)
    await projectRow(page).getByRole('button', { name: 'Edit options', exact: true }).click()
    await expect(
      activePopover(page).getByRole('button', { name: 'Remove option beta', exact: true }),
    ).toBeVisible()
  })
})
