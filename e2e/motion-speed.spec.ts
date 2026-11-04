/**
 * Settings › Appearance › Animations times every overlay's entry and every plain transition, not
 * only the token-driven ones: a Select's list, a dialog, a page link's right-click menu and a bare
 * `transition-*` on a button run at half their duration on Fast and at their own on Full.
 */

import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

const durationOf = (target: Locator, property: 'animationDuration' | 'transitionDuration') =>
  target.evaluate((el, key) => getComputedStyle(el)[key], property)

async function openAppearance(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Appearance')
  await expect(page.getByTestId('settings-panel-appearance')).toBeVisible()
}

const SPEEDS = [
  { motion: 'full', scale: 1 },
  { motion: 'fast', scale: 0.5 },
] as const

test.describe('animation speed reaches every overlay @settings', () => {
  for (const { motion, scale } of SPEEDS) {
    test(`${motion}: overlays and plain transitions run at ${scale}x`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem('agaric-motion', m), motion)
      await waitForBoot(page)
      const s = (ms: number) => `${(ms * scale) / 1000}s`

      // A button's plain transition, and a Select's list.
      const search = page.getByTestId('header-search-button')
      expect(await durationOf(search, 'transitionDuration')).toBe(s(150))
      await openAppearance(page)
      await page.getByRole('combobox', { name: 'Theme' }).click()
      expect(await durationOf(page.getByRole('listbox'), 'animationDuration')).toBe(s(150))
      await page.keyboard.press('Escape')

      // A dialog, timed `duration-moderate`.
      await page.getByTestId('header-search-button').click()
      expect(await durationOf(page.getByRole('dialog'), 'animationDuration')).toBe(s(200))
      await page.keyboard.press('Escape')

      // A page's right-click menu: it enters as the other menus do.
      await navigateToView(page, 'Pages')
      await page.locator('[id^="page-row-"]').first().click({ button: 'right' })
      const menu = page.getByRole('menu').filter({ hasText: 'Open in new tab' })
      await expect(menu).toBeVisible()
      expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none')
      expect(await durationOf(menu, 'animationDuration')).toBe(s(150))
    })
  }
})
