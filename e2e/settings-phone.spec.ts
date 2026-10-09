/**
 * E2E — Settings tab navigation and the quick-capture button on a phone (#5344).
 *
 * Below `sm` the tab rail stacked ~500px above the panel, so a tab tap changed
 * a panel the user could not see; phones now pick the tab from a Select. The
 * quick-capture button floats over the bottom of the scroll viewport, so the
 * viewport carries enough bottom padding for the last control to clear it,
 * except on Graph, whose canvas fills the viewport.
 */

import { devices } from '@playwright/test'

import { expect, navigateMobile, navigateToView, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

// Per-context fields only: `defaultBrowserType` would force a new worker.
const phone = {
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

test.describe('Settings on a phone', () => {
  test.use({ ...phone, viewport: { width: 390, height: 844 } })

  test('choosing a tab from the Select brings its panel on screen', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')

    await page.getByRole('combobox', { name: 'Settings', exact: true }).click()
    await page.getByRole('option', { name: 'Sync & devices', exact: true }).click()

    await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pair new device' })).toBeInViewport({
      ratio: 1,
    })
  })

  test('every tab option is a 44px touch target and the list needs no scrolling', async ({
    page,
  }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')
    await page.getByRole('combobox', { name: 'Settings', exact: true }).click()

    const options = page.getByRole('option')
    await expect(options).toHaveCount(13)
    for (const option of await options.all()) {
      await expect(option).toBeInViewport({ ratio: 1 })
      // Polled: the list zooms in from 95%, so an early read is a few px short.
      await expect
        .poll(async () => (await option.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44)
    }
  })
})

// The device's own 390x664 viewport: at 844px the General tab fits without
// scrolling, so its last control never reaches the bottom.
test.describe('Settings on a phone, scrolled to the end', () => {
  test.use({ ...phone, viewport: iPhone13.viewport })

  test('the last General control clears the quick-capture button', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')
    const showTour = page
      .getByTestId('settings-panel-general')
      .getByRole('button', { name: 'Show tour', exact: true })
    await expect(showTour).toBeVisible()
    await page.locator('#main-content').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })

    const control = await showTour.boundingBox()
    const fab = await page.getByTestId('quick-capture-fab').boundingBox()
    if (control === null || fab === null) throw new Error('Show tour or the FAB has no box')
    expect(
      control.y + control.height,
      `Show tour ends at ${control.y + control.height}px, the FAB starts at ${fab.y}px`,
    ).toBeLessThanOrEqual(fab.y)
  })
})

test.describe('Graph on a phone', () => {
  test.use({ ...phone, viewport: iPhone13.viewport })

  test('the canvas still runs under the quick-capture button', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Graph')
    const graph = page.getByTestId('graph-view')
    await expect(graph).toBeVisible()

    const canvas = await graph.boundingBox()
    const fab = await page.getByTestId('quick-capture-fab').boundingBox()
    if (canvas === null || fab === null) throw new Error('the graph or the FAB has no box')
    expect(
      canvas.y + canvas.height,
      `the graph ends at ${canvas.y + canvas.height}px, the FAB at ${fab.y + fab.height}px`,
    ).toBeGreaterThan(fab.y + fab.height)
  })
})

test.describe('Settings on a touch tablet', () => {
  test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } })

  test('the rail tabs are 44px touch targets', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    const tab = page.getByRole('tab', { name: 'General', exact: true })
    await expect(tab).toBeVisible()
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  })
})

test('Settings at a desktop width shows the tab rail, not the tab Select', async ({ page }) => {
  await waitForBoot(page)
  await navigateToView(page, 'Settings')

  await expect(page.getByRole('tablist', { name: 'Settings' })).toBeVisible()
  const select = page.getByRole('combobox', { name: 'Settings', exact: true, includeHidden: true })
  await expect(select).toHaveCount(1)
  await expect(select).toBeHidden()
})
