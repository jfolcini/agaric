/**
 * Custom CSS (#6558): Settings › Appearance takes a user stylesheet, applied
 * after the app's own, with a switch that turns it off. A snippet that sets a
 * documented token changes what it colours; the switch restores it; both stay
 * across navigating away and back. A sheet that hides the whole app is turned
 * off through the `agaric://settings/safe-mode` deep link.
 */

import type { Page } from '@playwright/test'

import {
  emitMockEvent,
  expect,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const CUSTOM = 'rgb(10, 120, 200)'

function background(page: Page): Promise<string> {
  return page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)
}

async function openAppearance(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Appearance')
}

const stylesheet = (page: Page) => page.getByRole('textbox', { name: 'Custom CSS stylesheet' })
const offSwitch = (page: Page) => page.getByRole('switch', { name: 'Custom CSS' })

test.describe('custom CSS @settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a snippet sets --background, the switch turns it off, and both stay', async ({ page }) => {
    const original = await background(page)
    expect(original).not.toBe(CUSTOM)
    await openAppearance(page)

    await stylesheet(page).fill(`:root { --background: ${CUSTOM}; }`)
    await expect.poll(() => background(page)).toBe(CUSTOM)

    await navigateToView(page, 'Journal')
    await expect.poll(() => background(page)).toBe(CUSTOM)
    await openAppearance(page)
    await expect(stylesheet(page)).toHaveValue(`:root { --background: ${CUSTOM}; }`)

    await offSwitch(page).click()
    await expect(offSwitch(page)).not.toBeChecked()
    await expect.poll(() => background(page)).toBe(original)

    await navigateToView(page, 'Journal')
    await expect.poll(() => background(page)).toBe(original)
    await openAppearance(page)
    await expect(offSwitch(page)).not.toBeChecked()

    await offSwitch(page).press('Space')
    await expect.poll(() => background(page)).toBe(CUSTOM)
  })

  test('a stored stylesheet applies from boot, and not while switched off', async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem('agaric-custom-css', `:root { --background: ${value}; }`)
    }, CUSTOM)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await expect.poll(() => background(page)).toBe(CUSTOM)

    await page.addInitScript(() => localStorage.setItem('agaric-custom-css-enabled', 'false'))
    await page.reload()
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    expect(await background(page)).not.toBe(CUSTOM)
  })

  test('a sheet that hides everything is turned off by the safe-mode link', async ({ page }) => {
    await openAppearance(page)
    await stylesheet(page).fill('* { display: none !important; }')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeHidden()

    await emitMockEvent(page, 'deeplink:open-settings', { tab: 'safe-mode' })
    await expect(offSwitch(page)).not.toBeChecked()
    await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await expect(stylesheet(page)).toHaveValue('* { display: none !important; }')
  })
})
