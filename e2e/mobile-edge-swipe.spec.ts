/**
 * E2E — left-edge swipe opens the mobile navigation drawer (#5741), and a nav
 * tap in the drawer navigates and closes it.
 *
 * In `e2e/` because the gesture is frontend only (`useSidebarEdgeSwipe`). The
 * touches go through Chromium's own input pipeline (CDP
 * `Input.dispatchTouchEvent`) so the hook's document listeners see a real finger:
 * a start inside `SWIPE_EDGE_ZONE` and horizontal travel past
 * `SWIPE_MIN_DISTANCE`.
 */

import { devices } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

test.use({
  viewport: iPhone13.viewport,
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
})

test('swiping from the left edge opens the drawer and a nav tap closes it @mobile', async ({
  page,
}) => {
  await waitForBoot(page)
  const drawer = page.locator('[data-mobile="true"]')
  await expect(drawer).toHaveCount(0)

  const cdp = await page.context().newCDPSession(page)
  const y = 400
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y }] })
  for (const x of [25, 45, 65, 85, 105]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()

  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByTestId('header-label')).toHaveText('Pages')
})
