/**
 * E2E — on a phone the navigation drawer opens only from the header button
 * (#5932). A swipe in from the left edge is Android's gesture-navigation Back,
 * so the app neither listens for it nor paints a strip there advertising it.
 *
 * The touches go through Chromium's own input pipeline (CDP
 * `Input.dispatchTouchEvent`), so any document touch listener sees a real finger.
 *
 * Also (#6532): the drawer's Agenda row, and which touch screens get the drawer
 * rather than the pinned sidebar.
 */

import { devices } from '@playwright/test'

import { expect, openMobileSidebar, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']
const iPad = devices['iPad Pro 11 landscape']

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

  // The swipe starts in the gutter below the header, on nothing that takes
  // touches itself: block rows, task checkboxes and the day's icon buttons
  // all reach into the gutter (#5929).
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  const header = await page.locator('main[data-slot="sidebar-inset"] > header').boundingBox()
  if (header == null) throw new Error('the app header has no box')
  const y = await page.evaluate((top) => {
    for (let at = Math.ceil(top); at < innerHeight; at += 2) {
      const hit = document.elementFromPoint(5, at)
      if (hit?.closest('[data-testid="sortable-block"], button, a, [role="button"]') == null) {
        return at
      }
    }
    return null
  }, header.y + header.height)
  if (y == null) throw new Error('no gutter row free of controls to start the swipe on')

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

// #6532 — the Agenda gets a drawer row of its own, one tap from anywhere.
test.describe('Agenda in the drawer @mobile @journal', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('opens the agenda and closes the drawer', async ({ page }) => {
    await waitForBoot(page)
    const sheet = await openMobileSidebar(page)
    await sheet.getByRole('button', { name: 'Agenda', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('agenda-view')).toBeVisible()
  })
})

// #6532 — a phone on its side is wider than the mobile breakpoint, but a
// pinned sidebar beside 360 px of height leaves the notes a sliver. `screen`
// too: the rule reads the screen's height (`usePhoneLayout`), and the
// project's desktop descriptor leaves a 1080 px one.
test.describe('a touch screen under 500 px tall gets the drawer @mobile', () => {
  const LANDSCAPE = { width: 863, height: 360 }
  test.use({ viewport: LANDSCAPE, screen: LANDSCAPE })

  test('a phone in landscape', async ({ page }) => {
    await waitForBoot(page)
    await expect(page.locator('[data-slot="sidebar"]:not([data-mobile])')).toHaveCount(0)
    await openMobileSidebar(page)
  })
})

test.describe('a touch tablet keeps the pinned sidebar @mobile', () => {
  test.use({ viewport: { width: 1024, height: 768 }, userAgent: iPad.userAgent })

  test('a tablet in landscape', async ({ page }) => {
    await waitForBoot(page)
    await expect(page.locator('[data-slot="sidebar"]:not([data-mobile])')).toBeInViewport()
    await expect(page.getByTestId('mobile-sidebar-trigger')).toHaveCount(0)
  })
})
