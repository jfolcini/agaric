/**
 * Where the page-adjacent views open from. #6544 — the Pages header's view
 * buttons name their destination in visible text at desktop widths. #7040 D2 —
 * Graph, Templates and Trash moved to the app sidebar's lower group, which the
 * phone's drawer renders too.
 */

import { devices } from '@playwright/test'

import {
  expect,
  expectViewLoaded,
  navigateToView,
  openMobileSidebar,
  test,
  waitForBoot,
} from './helpers'

const HEADER_DESTINATIONS = ['Tags', 'Advanced query'] as const
const SIDEBAR_DESTINATIONS = ['Graph', 'Templates', 'Trash'] as const

test.describe('desktop @pages @graph @search', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  for (const view of HEADER_DESTINATIONS) {
    test(`the ${view} button in the Pages header shows its name and opens the view`, async ({
      page,
    }) => {
      await waitForBoot(page)
      await navigateToView(page, 'Pages')
      const label = page
        .locator('.page-browser-header')
        .getByRole('button')
        .getByText(view, { exact: true })
      // A visually hidden label is a 1 px box; a shown one is as wide as its word.
      await expect
        .poll(() => label.evaluate((el) => el.getBoundingClientRect().width))
        .toBeGreaterThan(20)
      await label.click()
      await expectViewLoaded(page, view)
    })
  }

  test('the Pages header has no Graph, Templates or Trash button', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    const header = page.locator('.page-browser-header')
    await expect(header.getByRole('button', { name: 'Tags', exact: true })).toBeVisible()
    for (const view of SIDEBAR_DESTINATIONS) {
      await expect(header.getByRole('button', { name: new RegExp(`^${view}`) })).toHaveCount(0)
    }
  })

  for (const view of SIDEBAR_DESTINATIONS) {
    test(`the sidebar's ${view} item opens the view`, async ({ page }) => {
      await waitForBoot(page)
      const item = page
        .locator('[data-slot="sidebar"]')
        .getByRole('button', { name: new RegExp(`^${view}`) })
      await expect(item).toBeVisible()
      await item.click()
      await expectViewLoaded(page, view)
      await expect(item).toHaveAttribute('aria-current', 'page')
    })
  }
})

const pixel = devices['Pixel 7']

test.describe('phone drawer @pages @graph @mobile', () => {
  test.use({
    viewport: pixel.viewport,
    userAgent: pixel.userAgent,
    hasTouch: true,
    isMobile: true,
  })

  test('the drawer lists Graph, Templates and Trash, and closes on opening one', async ({
    page,
  }) => {
    await waitForBoot(page)
    const sheet = await openMobileSidebar(page)
    for (const view of SIDEBAR_DESTINATIONS) {
      await expect(sheet.getByRole('button', { name: new RegExp(`^${view}`) })).toBeVisible()
    }
    await sheet.getByRole('button', { name: 'Templates', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await expectViewLoaded(page, 'Templates')
  })
})
