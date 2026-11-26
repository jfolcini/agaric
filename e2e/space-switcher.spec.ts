import { devices } from '@playwright/test'

import { expect, openMobileSidebar, test, waitForBoot } from './helpers'

/**
 * Each space switcher option carries its space's colour dot, as the trigger and
 * Settings › Spaces do (#7040 O9). The seed colours Personal emerald and Work
 * blue (`src/lib/tauri-mock/seed.ts`).
 */
const ACCENTS = [
  ['Personal', /accent-emerald/],
  ['Work', /accent-blue/],
] as const

test.describe('Space switcher options show their space colour (#7040) @spaces', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('each desktop option has its dot, and the trigger keeps one', async ({ page }) => {
    await waitForBoot(page)
    const trigger = page.getByRole('combobox', { name: 'Switch space', exact: true })
    // The option's dot sits outside the text Radix copies into the trigger.
    await expect(trigger.locator('[data-testid$="-dot"]')).toHaveCount(1)
    await trigger.click()
    for (const [name, accent] of ACCENTS) {
      await expect(
        page.getByRole('option', { name, exact: true }).getByTestId('space-option-dot'),
      ).toHaveAttribute('style', accent)
    }
  })
})

test.describe('Space switcher on a phone shows each space colour (#7040) @spaces @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    userAgent: iPhone13.userAgent,
  })

  test('each row of the menu sheet has its dot', async ({ page }) => {
    await waitForBoot(page)
    const drawer = await openMobileSidebar(page)
    await drawer.getByLabel('Switch space', { exact: true }).tap()
    const sheet = page.getByRole('dialog', { name: 'Switch space' })
    for (const [name, accent] of ACCENTS) {
      await expect(
        sheet.getByRole('button', { name, exact: true }).getByTestId('space-option-dot'),
      ).toHaveAttribute('style', accent)
    }
  })
})
