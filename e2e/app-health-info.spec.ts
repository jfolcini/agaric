import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  fingerTap,
  navigateMobile,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

// #6895 — each App health counter's explanation sits behind its label. It used
// to be a hover tooltip, which a tap never opens, so a phone user could not
// read "Should stay at zero; if not, run the integrity check".

const iPhone13 = devices['iPhone 13']
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

const LABEL = 'Writes the sync engine missed'
const INFO = /Should stay at zero; if not, run the integrity check/

function counterLabel(page: Page): Locator {
  return page.getByRole('button', { name: LABEL, exact: true })
}

test.describe('App health counter explanations on a phone @settings', () => {
  test.use(PHONE)

  test('a tap opens the explanation and a tap outside closes it @settings', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'App health')

    const label = counterLabel(page)
    // The finger's target is the 44 px hit area, not the one line of text.
    const hitHeight = await label.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el, '::before').height),
    )
    expect(hitHeight).toBeGreaterThanOrEqual(44)

    await fingerTap(page, label)
    const info = page.getByRole('dialog', { name: LABEL })
    await expect(info).toHaveText(INFO)

    await fingerTap(page, page.getByTestId('integrity-panel-title'))
    await expect(info).toHaveCount(0)
  })
})

test.describe('App health counter explanations on desktop @settings', () => {
  test('the keyboard opens the explanation and Escape closes it @settings', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Status')

    const label = counterLabel(page)
    await label.focus()
    await page.keyboard.press('Enter')
    const info = page.getByRole('dialog', { name: LABEL })
    await expect(info).toHaveText(INFO)

    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    await expect(label).toBeFocused()

    await label.click()
    await expect(info).toHaveText(INFO)
  })
})
