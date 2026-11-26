import { expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * The desktop Tauri app is never touch, whatever its pointer reports (#7040 M7).
 *
 * WebKitGTK reports `(pointer: coarse)` for a plain mouse on some Linux
 * machines (#1236). The page here reports a coarse pointer with touch points,
 * as such a webview can, and identifies as the Tauri app as the runtime does,
 * through `window.isTauri`; its user agent is not Android's. CSS (`coarse`,
 * `hover-reveal`) and JS (`useIsTouch`) must both give the desktop layout.
 */

test.describe('the desktop app with a coarse pointer @mobile @pages @editor', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isTauri', { value: true })
    })
  })

  test('lays out for a mouse: row actions hidden at rest, desktop row gap and control lane', async ({
    page,
  }) => {
    await waitForBoot(page)
    // The WebKitGTK case: both browser signals say touch.
    expect(
      await page.evaluate(
        () => window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0,
      ),
    ).toBe(true)

    await navigateToView(page, 'Pages')
    const deleteButton = page.getByRole('button', { name: 'Delete page' }).first()
    await expect(deleteButton).toBeAttached()
    await expect(deleteButton).toHaveCSS('opacity', '0')
    await expect(deleteButton).toHaveCSS('min-height', 'auto')

    await openPage(page, 'Quick Notes')
    const rowGap = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.height = 'var(--block-row-gap)'
      document.body.append(probe)
      const height = getComputedStyle(probe).height
      probe.remove()
      return height
    })
    expect(rowGap).toBe('4px')
    await expect(page.locator('.block-control-lane').first()).toBeAttached()
  })
})
