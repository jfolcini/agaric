/**
 * E2E — the app chrome's geometry (#5332 item 8): a 48px header, a 2px space
 * stripe, a one-row sidebar footer, and a page header that fits one row on a
 * phone. Measured on the rendered layout, which unit tests cannot see.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { expect, navigateToView, openPage, openPageMobile, test, waitForBoot } from './helpers'

function appHeader(page: Page): Locator {
  return page.locator('main[data-slot="sidebar-inset"] > header')
}

async function box(locator: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  const b = await locator.boundingBox()
  if (b == null) throw new Error('element has no box')
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
}

test.describe('desktop chrome', () => {
  test('the app header is 48px tall on every sidebar view and on a page', async ({ page }) => {
    await waitForBoot(page)
    for (const view of ['Journal', 'Pages', 'Search', 'Tags', 'Settings']) {
      await navigateToView(page, view)
      expect((await box(appHeader(page))).h, `${view} header`).toBe(48)
    }
    await openPage(page, 'Projects')
    expect((await box(appHeader(page))).h, 'page header').toBe(48)
  })

  test('the space stripe is 2px', async ({ page }) => {
    await waitForBoot(page)
    expect((await box(page.getByTestId('space-top-stripe'))).h).toBe(2)
  })

  test('the sidebar footer is one row: Sync beside Settings', async ({ page }) => {
    await waitForBoot(page)
    const footer = page.locator('[data-sidebar="footer"]')
    const sync = await box(footer.getByRole('button', { name: 'Sync', exact: true }))
    const settings = await box(footer.getByRole('button', { name: 'Settings', exact: true }))
    expect(settings.y).toBe(sync.y)
    expect(settings.x).toBeGreaterThan(sync.x)
    expect((await box(footer)).h).toBeLessThanOrEqual(sync.h + 16)
  })

  test('Settings names itself once, as the header h1', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    await expect(page.getByTestId('settings-tab-rail')).toBeVisible()
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Settings')
    await expect(page.locator('main').getByText('Settings', { exact: true })).toHaveCount(1)
  })
})

const iPhone13 = devices['iPhone 13']

test.describe('phone chrome', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('the app header is one 48px row on Journal, Search and a page', async ({ page }) => {
    await waitForBoot(page)
    expect((await box(appHeader(page))).h, 'Journal header').toBe(48)
    await navigateToView(page, 'Search')
    expect((await box(appHeader(page))).h, 'Search header').toBe(48)
    await openPageMobile(page, 'Projects')
    expect((await box(appHeader(page))).h, 'page header').toBe(48)
  })

  test('the page header fits one row: title, star and Page actions', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, 'Projects')

    const title = await box(page.locator('[aria-label="Page title"]'))
    const star = await box(page.getByRole('button', { name: 'Bookmark this page', exact: true }))
    const actions = await box(page.getByRole('button', { name: 'Page actions', exact: true }))
    for (const [name, b] of [
      ['star', star],
      ['Page actions', actions],
    ] as const) {
      expect(b.y, `${name} top`).toBeLessThan(title.y + title.h)
      expect(b.y + b.h, `${name} bottom`).toBeGreaterThan(title.y)
      expect(b.x, `${name} sits right of the title`).toBeGreaterThanOrEqual(title.x + title.w)
      expect(Math.min(b.w, b.h), `${name} touch target`).toBeGreaterThanOrEqual(44)
    }
  })
})
