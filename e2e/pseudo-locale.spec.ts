/**
 * The pseudo-locale (`en-XA`), end to end: debug mode offers it in
 * Settings › General, and its generated catalog is deliverable from a
 * production build and renders every label accented, padded and in `⟦…⟧`.
 */

import { expect, navigateToView, test, waitForBoot } from './helpers'

test.describe('Pseudo-locale @settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('debug mode offers the pseudo-locale, which marks every label, and English comes back', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await page.getByRole('tab', { name: 'About', exact: true }).click()
    await page.getByRole('switch', { name: 'Debug mode' }).click()
    await page.getByRole('tab', { name: 'General', exact: true }).click()

    await page.getByRole('combobox', { name: 'Language' }).click()
    await page.getByRole('option', { name: 'Pseudo-locale (en-XA)', exact: true }).click()

    await expect(page.getByRole('combobox', { name: '⟦Ŵééķ šţáŕţš óñ ~ ~ ~⟧' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA')

    await page.getByRole('combobox', { name: '⟦Ĺáñğúáğé ~ ~⟧' }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()

    await expect(page.getByRole('combobox', { name: 'Week starts on' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
