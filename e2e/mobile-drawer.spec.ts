/**
 * E2E — on a phone the navigation drawer opens only from the header button
 * (#5932). A swipe in from the left edge is Android's gesture-navigation Back,
 * so the app neither listens for it nor paints a strip there advertising it.
 *
 * The touches go through Chromium's own input pipeline (CDP
 * `Input.dispatchTouchEvent`), so any document touch listener sees a real finger.
 */

import { devices } from '@playwright/test'

import { expect, openMobileSidebar, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
})

test('the drawer opens from the header button, not from a left-edge swipe @mobile', async ({
  page,
}) => {
  await waitForBoot(page)
  const drawer = page.locator('[data-mobile="true"]')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByTestId('sidebar-swipe-hint')).toHaveCount(0)

  // The swipe starts in the gutter beside the day heading, on nothing that
  // takes touches itself: block rows hang into the gutter (#5929).
  const heading = page.getByRole('heading', { level: 1 }).first()
  await expect(heading).toBeVisible()
  const box = await heading.boundingBox()
  const y = Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2)
  const startsOnControl = await page.evaluate(
    (at) =>
      document
        .elementFromPoint(5, at)
        ?.closest('[data-testid="sortable-block"], button, a, [role="button"]') != null,
    y,
  )
  expect(startsOnControl, 'swipe start lands on a control').toBe(false)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y }] })
  for (const x of [25, 45, 65, 85, 105]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  // Two frames: any state update the swipe scheduled has rendered by then.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await expect(drawer).toHaveCount(0)

  await openMobileSidebar(page)
})
