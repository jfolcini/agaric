import type { Locator, Page } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * One caret left of the tab strip opens a switcher over every open tab, with
 * a filter input on top that narrows the list as you type (#5993). Tabs are
 * frontend state, so the mock-backed build can show any of it failing.
 */

function tabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
}

const caret = (page: Page) => page.getByRole('button', { name: 'Switch tab', exact: true })
const switcher = (page: Page) => page.getByRole('dialog', { name: 'Switch tab' })
const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')

async function openThreeTabs(page: Page) {
  await openPage(page, 'Getting Started')
  await page.keyboard.press('Control+t')
  await openPage(page, 'Quick Notes')
  await page.keyboard.press('Control+t')
  await openPage(page, 'Projects')
  await expect(tabs(page)).toHaveText(['Getting Started', 'Quick Notes', 'Projects'])
}

test.describe('tab switcher @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('filters the open tabs as you type and Enter opens the match', async ({ page }) => {
    await openThreeTabs(page)
    await caret(page).click()

    const filter = switcher(page).getByRole('combobox')
    await expect(filter).toBeFocused()
    await expect(switcher(page).getByRole('option')).toHaveText([
      'Getting Started',
      'Quick Notes',
      'Active tabProjects',
    ])

    await page.keyboard.type('NOTES')
    await expect(switcher(page).getByRole('option')).toHaveText(['Quick Notes'])
    await page.screenshot({
      path: test.info().outputPath('tab-switcher-filtered.png'),
      animations: 'disabled',
    })

    await page.keyboard.press('Enter')
    await expect(switcher(page)).toHaveCount(0)
    await expect(pageTitle(page)).toHaveText('Quick Notes')
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true')
  })

  test('a row closes its tab and Escape closes the switcher', async ({ page }) => {
    await openThreeTabs(page)
    await caret(page).click()

    await switcher(page)
      .getByRole('option', { name: 'Getting Started' })
      .locator('[data-tab-switcher-close]')
      .click()
    await expect(switcher(page).getByRole('option')).toHaveText([
      'Quick Notes',
      'Active tabProjects',
    ])
    await expect(tabs(page)).toHaveText(['Quick Notes', 'Projects'])

    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await expect(pageTitle(page)).toHaveText('Projects')
  })
})
