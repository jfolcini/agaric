import type { Locator, Page } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * The recents strip above the editor lists visited pages newest first, minus
 * the page on screen. A click reopens a page; a middle click or a Ctrl click
 * opens it in a background tab, leaving the current page on screen. All of it
 * is frontend state (the recent-pages and tabs stores), so the mock-backed
 * build can show any of it failing.
 */

function recentChips(page: Page): Locator {
  return page.getByTestId('quick-access-bar').locator('[data-slot="recent-page-chip"]')
}

function recentChip(page: Page, title: string): Locator {
  return page.getByTestId('quick-access-bar').getByRole('button', { name: title, exact: true })
}

function tabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
}

const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')

test('lists visited pages newest first; click reopens, middle and Ctrl click open background tabs', async ({
  page,
}) => {
  await waitForBoot(page)
  for (const title of ['Getting Started', 'Quick Notes', 'Projects', 'Meetings']) {
    await openPage(page, title)
    await expect(pageTitle(page)).toHaveText(title)
  }
  await expect(recentChips(page)).toHaveText(['Projects', 'Quick Notes', 'Getting Started'])

  await recentChip(page, 'Quick Notes').click()
  await expect(pageTitle(page)).toHaveText('Quick Notes')
  await expect(recentChips(page)).toHaveText(['Meetings', 'Projects', 'Getting Started'])

  await recentChip(page, 'Getting Started').click({ button: 'middle' })
  await expect(tabs(page)).toHaveCount(2)
  await expect(tabs(page).nth(1)).toHaveText(/Getting Started/)
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'false')
  await expect(pageTitle(page)).toHaveText('Quick Notes')

  await recentChip(page, 'Projects').click({ modifiers: ['ControlOrMeta'] })
  await expect(tabs(page)).toHaveCount(3)
  await expect(tabs(page).nth(2)).toHaveText(/Projects/)
  await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'false')
  await expect(pageTitle(page)).toHaveText('Quick Notes')
})
