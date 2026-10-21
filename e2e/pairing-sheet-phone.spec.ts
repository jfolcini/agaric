/**
 * E2E — the pairing sheet's layout on a phone, in both themes.
 *
 * The QR tile stays light in every theme (scanners need dark modules on a
 * light ground) but drops its outline in dark, where it read as a white slab
 * with a dark rim. On the joiner screen the "Recommended" badge wraps under
 * its tab label at phone width; both tab labels must still share a line.
 */

import { devices, type Locator } from '@playwright/test'

import { activeSheet, expect, navigateMobile, openSettingsTab, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

// Per-context fields only: `defaultBrowserType` would force a new worker.
const phone = {
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

/** Top of the rendered text `label` inside `tab`, ignoring the badge that may wrap below it. */
function labelTop(tab: Locator, label: string): Promise<number> {
  return tab.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() !== text) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().top
    }
    throw new Error(`no text node "${text}" in tab`)
  }, label)
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Pairing sheet on a phone, ${theme} theme @mobile @sync`, () => {
    test.use({ ...phone, viewport: { width: 390, height: 844 } })

    test('QR tile, tab labels, word inputs and the role switch sit right', async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
      await waitForBoot(page)
      await navigateMobile(page, 'Settings')
      await openSettingsTab(page, 'Sync & devices')
      await page.getByRole('button', { name: /Pair new device/ }).click()
      const sheet = activeSheet(page)

      const qr = sheet.getByTestId('pairing-qr-code')
      await expect(qr).toBeVisible()
      await expect(qr).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(qr).toHaveCSS('padding-top', '0px')
      await expect(qr).toHaveCSS('border-top-width', theme === 'dark' ? '0px' : '1px')

      await sheet.getByRole('button', { name: /have a code from the other device/i }).click()
      const scanTab = sheet.getByRole('tab', { name: /Scan QR code/ })
      const typeTab = sheet.getByRole('tab', { name: 'Type passphrase', exact: true })
      await expect(typeTab).toBeVisible()
      expect(await labelTop(scanTab, 'Scan QR code')).toBeCloseTo(
        await labelTop(typeTab, 'Type passphrase'),
        0,
      )

      const words = sheet.locator('input[aria-label*="Passphrase word"]')
      await expect(words).toHaveCount(4)
      for (const word of await words.all()) await expect(word).not.toHaveAttribute('placeholder')

      // The switch back to the host path sits one separator margin above the
      // OR divider, not a margin stacked on its 44 px touch target.
      const switchBox = await sheet
        .getByRole('button', { name: 'Show my code instead', exact: true })
        .boundingBox()
      // The OR divider is the sheet's first separator on the joiner screen.
      const dividerBox = await sheet.locator('[data-slot="separator"]').first().boundingBox()
      if (!switchBox || !dividerBox) throw new Error('switch link or OR divider not laid out')
      expect(dividerBox.y - (switchBox.y + switchBox.height)).toBeLessThanOrEqual(16)
    })
  })
}
