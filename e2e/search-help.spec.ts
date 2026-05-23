/**
 * E2E — PEND-58f search help dialog (E2E-7).
 *
 * UX-1 wired the previously-dead SearchHelpDialog to a `?` toolbar button and
 * a `?` keyboard shortcut (on an empty input). Covers: open via button, open
 * via the keyboard shortcut, the filter-syntax section renders, and close.
 */

import { activeDialog, expect, openSearchView, test } from './helpers'

test.describe('Search help dialog (PEND-58f E2E-7)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('opens via the `?` toolbar button and shows the filter-syntax section', async ({ page }) => {
    await page.getByTestId('search-help-button').click()
    const dialog = page.getByTestId('search-help-dialog')
    await expect(dialog).toBeVisible()
    // The filter-syntax heading + a representative token reference render.
    await expect(dialog.getByRole('heading', { name: 'Filter syntax' })).toBeVisible()
    await expect(dialog).toContainText('tag:#name')
    await expect(dialog).toContainText('prop:KEY=VALUE')
    // Other PEND-55 sections are present too.
    await expect(dialog.getByRole('heading', { name: 'Regex syntax' })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Toggles' })).toBeVisible()
  })

  test('opens via the `?` keyboard shortcut on an empty input', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await expect(input).toHaveValue('')
    await input.press('?')
    await expect(page.getByTestId('search-help-dialog')).toBeVisible()
  })

  test('the `?` shortcut does NOT fire when the input has content', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('foo')
    await input.press('?')
    // `?` is typed into the input instead of opening help.
    await expect(input).toHaveValue('foo?')
    await expect(page.getByTestId('search-help-dialog')).toHaveCount(0)
  })

  test('closes via Escape', async ({ page }) => {
    await page.getByTestId('search-help-button').click()
    await expect(page.getByTestId('search-help-dialog')).toBeVisible()
    await activeDialog(page).press('Escape')
    await expect(page.getByTestId('search-help-dialog')).toHaveCount(0)
  })
})
