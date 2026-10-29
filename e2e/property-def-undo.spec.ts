import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  expect,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5841 S1 — a property definition change is an op, so the toast after it
 * offers Undo. Deleting the seeded, unused `reviewer` definition and pressing
 * Undo brings it back, as Settings › Properties shows after a round-trip.
 */

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

async function openProperties(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
}

test.describe('Undo a property definition change @settings', () => {
  test('Undo on the delete toast brings the definition back', async ({ page }) => {
    await openProperties(page)
    const panel = page.locator('[data-testid="settings-panel-properties"]')
    const reviewerRow = panel.locator('ul > li', { hasText: 'reviewer' })
    await reviewerRow.getByRole('button', { name: 'Delete property reviewer' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(reviewerRow).toHaveCount(0)

    await page
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(reviewerRow).toBeVisible()
  })
})
