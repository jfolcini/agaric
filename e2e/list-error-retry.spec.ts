/**
 * A list that failed to load shows a red alert with a Retry button (#7040). The
 * button's edge must stand out from the alert's fill by WCAG 1.4.11's 3:1 in
 * every shipped theme; an outline button's grey edge and translucent fill sank
 * into the red.
 */

import { clearConsoleErrors, expect, navigateToView, test, waitForBoot } from './helpers'

const THEMES = [
  'light',
  'dark',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'one-dark-pro',
] as const

interface MockErrorWindow extends Window {
  __injectMockError: (command: string, error: string) => void
}

for (const theme of THEMES) {
  test(`the Retry button's edge clears 3:1 on the error alert in the ${theme} theme @pages @settings`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await waitForBoot(page)
    await page.evaluate(() =>
      (window as unknown as MockErrorWindow).__injectMockError(
        'list_all_tags_in_space',
        'database is locked',
      ),
    )
    await navigateToView(page, 'Tags')
    const retry = page.getByTestId('list-error-state-retry')
    await expect(retry).toBeVisible()
    // The failed load logs its error, as it should.
    clearConsoleErrors(page)

    const ratio = await retry.evaluate((button) => {
      // A canvas resolves any CSS colour (oklch included) to the sRGB it paints.
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('no 2d canvas')
      const luminance = (css: string): number => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = css
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map((v) => {
          const c = v / 255
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
      }
      const alert = button.closest('[role="alert"]')
      if (!alert) throw new Error('the Retry button is not inside the alert')
      const edge = luminance(getComputedStyle(button).borderTopColor)
      const fill = luminance(getComputedStyle(alert).backgroundColor)
      return (Math.max(edge, fill) + 0.05) / (Math.min(edge, fill) + 0.05)
    })
    expect(ratio).toBeGreaterThanOrEqual(3)
  })
}
