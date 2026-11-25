import { devices, type Locator, type Page } from '@playwright/test'

import { expect, navigateToView, openPage, openPageMobile, test, waitForBoot } from './helpers'

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

test('lists visited pages newest first; a click reopens one and moves it to the front @pages', async ({
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
})

// One test per trigger: the first background tab takes the strip away (below).
const BACKGROUND_TAB_CLICKS: [string, Parameters<Locator['click']>[0]][] = [
  ['a middle click', { button: 'middle' }],
  ['a Ctrl click', { modifiers: ['ControlOrMeta'] }],
]
for (const [trigger, click] of BACKGROUND_TAB_CLICKS) {
  test(`${trigger} on a chip opens a background tab and leaves the page on screen @pages`, async ({
    page,
  }) => {
    await waitForBoot(page)
    for (const title of ['Getting Started', 'Quick Notes', 'Projects']) {
      await openPage(page, title)
      await expect(pageTitle(page)).toHaveText(title)
    }

    await recentChip(page, 'Getting Started').click(click)
    await expect(tabs(page)).toHaveCount(2)
    await expect(tabs(page).nth(1)).toHaveText(/Getting Started/)
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'false')
    await expect(pageTitle(page)).toHaveText('Projects')
  })
}

// S4 (#7040): the open tabs already list these pages, so with more than one
// the strip is gone, and it returns with the last tab closed.
test('the strip gives way to the tab bar while tabs are open @pages @tabs', async ({ page }) => {
  await waitForBoot(page)
  for (const title of ['Getting Started', 'Quick Notes']) {
    await openPage(page, title)
    await expect(pageTitle(page)).toHaveText(title)
  }
  // One tab: the strip holds the page left behind, and there is no tab bar.
  await expect(recentChips(page)).toHaveText(['Getting Started'])
  await expect(tabs(page)).toHaveCount(0)

  await recentChip(page, 'Getting Started').click({ button: 'middle' })
  await expect(tabs(page)).toHaveCount(2)
  await expect(page.getByTestId('quick-access-bar')).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath('tabs-no-strip.png'),
    animations: 'disabled',
  })

  await tabs(page).nth(1).locator('[data-tab-close]').click()
  await expect(tabs(page)).toHaveCount(0)
  await expect(recentChips(page)).toHaveText(['Getting Started'])
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

// S4 (#7040): a phone keeps no strip; the palette's recents are how it returns
// to a page it left.
test.describe('on a phone @mobile @pages', () => {
  const pixel7 = devices['Pixel 7']
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: pixel7.hasTouch,
    isMobile: pixel7.isMobile,
    deviceScaleFactor: pixel7.deviceScaleFactor,
    userAgent: pixel7.userAgent,
  })

  test('there is no strip, and the search sheet lists the recent pages', async ({ page }) => {
    await waitForBoot(page)
    for (const title of ['Getting Started', 'Quick Notes']) {
      await openPageMobile(page, title)
      await expect(pageTitle(page)).toHaveText(title)
    }
    await page.screenshot({
      path: test.info().outputPath('phone-no-strip.png'),
      animations: 'disabled',
    })
    await expect(page.getByTestId('quick-access-bar')).toHaveCount(0)

    // The page left behind is still a recent: the sheet's empty state offers it.
    await page.getByTestId('search-sheet-trigger').click()
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet).toBeVisible()
    await page.getByTestId('search-sheet-segment-all-pages').click()
    await expect(
      sheet.getByTestId('palette-recents-group').getByText('Getting Started', { exact: true }),
    ).toBeVisible()
  })
})
