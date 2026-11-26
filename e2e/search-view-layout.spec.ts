/**
 * E2E — how the Search view lays out (#7040 D4, P6): the input keeps its width
 * as the query grows, so the controls beside it stay put, and a Recent page is
 * a list row the shape of a result row, not a card. Layout only the browser
 * computes, and none of it reads what the backend stores, so the mock serves.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  navigateMobile,
  openPage,
  openPageMobile,
  openSearchView,
  seedSearchBlocks,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const height = async (locator: Locator): Promise<number> =>
  (await locator.boundingBox())?.height ?? Number.NaN

/** A Recent row's height, then a one-line result row's: Recent shows only while the query is empty. */
async function recentAndResultHeights(page: Page): Promise<[number, number]> {
  const recent = page
    .getByRole('list', { name: 'Recent' })
    .getByRole('button', { name: 'Getting Started', exact: true })
  await expect(recent).toBeVisible()
  const recentHeight = await height(recent)
  const [id] = await seedSearchBlocks(page, [{ content: 'zebraquartz' }])
  await submitSearch(page, 'zebraquartz')
  const result = page.getByTestId(`search-result-row-${id}`)
  await expect(result).toBeVisible()
  return [recentHeight, await height(result)]
}

test.describe('Search view layout @search', () => {
  test('the Search button stays put as the query grows', async ({ page }) => {
    const input = await openSearchView(page)
    const button = page.getByRole('search').getByRole('button', { name: 'Search', exact: true })
    const before = await button.boundingBox()
    await input.fill('a query long enough to have grown the field')
    await expect(page.getByTestId('search-input-clear')).toBeVisible()
    expect(await button.boundingBox()).toEqual(before)
  })

  test('a drawn rule sets the search modes apart from Replace', async ({ page }) => {
    await openSearchView(page)
    const rule = page.getByRole('search').locator('[data-slot="separator"]')
    expect(await height(rule)).toBe(24)
  })

  test('a Recent page is a row the height of a result row', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await openSearchView(page)
    const [recent, result] = await recentAndResultHeights(page)
    expect(recent).toBe(result)
  })
})

const iPhone13 = devices['iPhone 13']

test.describe('Search view layout on a phone @search @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('a Recent page is a row the height of a result row', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, 'Getting Started')
    await navigateMobile(page, 'Search')
    const [recent, result] = await recentAndResultHeights(page)
    expect(recent).toBe(result)
  })
})
