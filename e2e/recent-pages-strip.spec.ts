import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * The recents strip above the editor lists visited pages newest first, minus
 * the page on screen. A click reopens a page and moves it to the front; a
 * middle click or a Ctrl click opens it in a background tab, leaving the
 * current page on screen. All of it is frontend state (the recent-pages and
 * tabs stores), so the mock-backed build can show any of it failing.
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

test('lists visited pages newest first; click reopens, middle and Ctrl click open background tabs @pages', async ({
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
  // The page on screen is hidden, so its move to the front shows only once it is left.
  await recentChip(page, 'Meetings').click()
  await expect(pageTitle(page)).toHaveText('Meetings')
  await expect(recentChips(page)).toHaveText(['Quick Notes', 'Projects', 'Getting Started'])

  await recentChip(page, 'Getting Started').click({ button: 'middle' })
  await expect(tabs(page)).toHaveCount(2)
  await expect(tabs(page).nth(1)).toHaveText(/Getting Started/)
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'false')
  await expect(pageTitle(page)).toHaveText('Meetings')

  await recentChip(page, 'Projects').click({ modifiers: ['ControlOrMeta'] })
  await expect(tabs(page)).toHaveCount(3)
  await expect(tabs(page).nth(2)).toHaveText(/Projects/)
  await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'false')
  await expect(pageTitle(page)).toHaveText('Meetings')
})

// #5993: no page opens from inside Settings.
test('the strip is gone on Settings and back on the next view @pages @settings', async ({
  page,
}) => {
  await waitForBoot(page)
  for (const title of ['Getting Started', 'Quick Notes']) {
    await openPage(page, title)
    await expect(pageTitle(page)).toHaveText(title)
  }
  await expect(recentChips(page)).toHaveText(['Getting Started'])

  await navigateToView(page, 'Settings')
  await expect(page.getByTestId('settings-tab-rail')).toBeVisible()
  await expect(page.getByTestId('quick-access-bar')).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath('settings-no-strip.png'),
    animations: 'disabled',
  })

  await navigateToView(page, 'Journal')
  await expect(recentChips(page)).toHaveText(['Getting Started'])
})
