/**
 * E2E — the desktop header's Search button opens the Ctrl+K palette, so a
 * user who has never heard of the shortcut can still go to a page.
 */

import { expect, test, waitForBoot } from './helpers'

test.describe('header search button (desktop)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('click, type a page title, Enter lands on that page', async ({ page }) => {
    await page.getByTestId('header-search-button').click()

    const paletteInput = page.getByTestId('command-palette-input')
    await expect(paletteInput).toBeFocused()

    await paletteInput.fill('Projects')
    await expect(page.getByRole('option', { name: /Projects/ }).first()).toBeVisible()
    await page.keyboard.press('Enter')

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Projects')
    await expect(paletteInput).not.toBeVisible()
  })

  test('is on the Pages view too, and the tooltip names both shortcuts', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    const button = page.getByTestId('header-search-button')
    await expect(button).toHaveAccessibleName('Search')
    await expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    await button.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toContainText('Search')
    await expect(tooltip).toContainText('Find in page')
  })
})
