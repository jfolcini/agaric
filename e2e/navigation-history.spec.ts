/**
 * E2E — the header's Back / Forward history.
 *
 * It replaced the page editor's own back arrow, which only knew the open
 * tab's page stack: from the journal, Pages or Settings there was no way back.
 * These specs walk a route across views, a page and journal days, and assert
 * what is on screen after each step.
 */

import { expect, openPage, test, waitForBoot } from './helpers'

test.describe('Back / Forward history', () => {
  test('steps back and forward through views and pages', async ({ page }) => {
    await waitForBoot(page)
    const header = page.locator('header').first()
    const back = header.getByRole('button', { name: 'Back', exact: true })
    const forward = header.getByRole('button', { name: 'Forward', exact: true })
    const headerLabel = page.getByTestId('header-label')
    const pageTitle = page.locator('[aria-label="Page title"]')
    await expect(back).toBeDisabled()

    await openPage(page, 'Getting Started')
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await expect(headerLabel).toHaveText('Settings')

    await back.click()
    await expect(pageTitle).toHaveText('Getting Started')
    await back.click()
    await expect(headerLabel).toHaveText('Pages')
    await back.click()
    await expect(page.getByTestId('journal-header')).toBeVisible()
    await expect(back).toBeDisabled()

    await forward.click()
    await expect(headerLabel).toHaveText('Pages')
    await forward.click()
    await expect(pageTitle).toHaveText('Getting Started')
  })

  test('a journal day is a step of its own', async ({ page }) => {
    await waitForBoot(page)
    const header = page.locator('header').first()
    const dateDisplay = page.getByTestId('date-display')
    const today = await dateDisplay.textContent()

    await page.getByRole('button', { name: 'Next day' }).click()
    await expect(dateDisplay).not.toHaveText(today ?? '')

    await header.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(dateDisplay).toHaveText(today ?? '')
  })
})
