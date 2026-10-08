/**
 * #5332 — the active nav item is a neutral pill with no bar, so its fill is
 * the only thing telling it apart from a hovered item. Hover must paint a
 * lighter fill than active, in the app sidebar (its nav rows and its footer
 * icons) and in the Settings tab rail.
 */

import type { Locator, Page } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

const fill = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor)

async function expectHoverDiffersFromActive(page: Page, active: Locator, other: Locator) {
  await page.mouse.move(0, 0)
  const restFill = await fill(other)
  const activeFill = await fill(active)
  expect(activeFill, 'active vs an item at rest').not.toBe(restFill)
  await other.hover()
  await expect.poll(() => fill(other)).not.toBe(restFill)
  const hoverFill = await fill(other)
  expect(hoverFill).not.toBe(activeFill)
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`active nav item vs hover (${theme})`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
      await waitForBoot(page)
    })

    test('app sidebar', async ({ page }) => {
      const sidebar = page.locator('[data-slot="sidebar"]')
      await sidebar.getByRole('button', { name: 'Pages', exact: true }).click()
      const active = sidebar.locator('[data-sidebar="menu-button"][data-active="true"]')
      await expect(active).toHaveText('Pages')
      await expectHoverDiffersFromActive(
        page,
        active,
        sidebar.getByRole('button', { name: 'Journal', exact: true }),
      )
    })

    test('app sidebar footer', async ({ page }) => {
      // The footer icons are Buttons, which fade their fill: compare end states.
      await page.addStyleTag({ content: '* { transition: none !important; }' })
      const footer = page.locator('[data-sidebar="footer"]')
      const settings = footer.getByRole('button', { name: 'Settings', exact: true })
      await settings.click()
      await expect(settings).toHaveAttribute('aria-current', 'page')
      await expectHoverDiffersFromActive(
        page,
        settings,
        footer.getByRole('button', { name: 'Sync', exact: true }),
      )
    })

    test('settings tab rail', async ({ page }) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Appearance' }).click()
      await expectHoverDiffersFromActive(
        page,
        page.getByRole('tab', { name: 'Appearance' }),
        page.getByRole('tab', { name: 'Editor' }),
      )
    })
  })
}
