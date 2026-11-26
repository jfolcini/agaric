import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  attachFile,
  expect,
  navigateToView,
  openPage,
  openPageMobile,
  test,
  waitForBoot,
} from './helpers'

/**
 * The desktop Tauri app is never touch, whatever its pointer reports (#7040 M7).
 *
 * WebKitGTK reports `(pointer: coarse)` for a plain mouse on some Linux
 * machines (#1236). The page here reports a coarse pointer with touch points,
 * as such a webview can, and identifies as the Tauri app as the runtime does,
 * through `window.isTauri`; its user agent is not Android's. CSS (`coarse`,
 * `hover-reveal`) and JS (`useIsTouch`) must both give the desktop layout.
 */

const iPhone13 = devices['iPhone 13']

/**
 * Sizes that a `coarse:` class sets on a control (#7040 M6): a list row, an
 * icon button and a menu row.
 */
async function touchSizes(
  page: Page,
  open: (page: Page, title: string) => Promise<void>,
): Promise<Record<string, string>> {
  const css = (control: Locator, property: string) =>
    control.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property)

  await navigateToView(page, 'Pages')
  const listRow = await css(page.locator('[data-page-item]').first(), 'min-height')

  await open(page, 'Quick Notes')
  const actions = page.getByRole('button', { name: 'Page actions', exact: true })
  const iconButton = await css(actions, 'width')
  await actions.click()
  const menuRow = await css(activeMenu(page).getByRole('menuitem').first(), 'min-height')

  return { listRow, iconButton, menuRow }
}

/** A 1×1 PNG, enough for the browser to decode as an image. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * An image's resize hint and corner handle, which touch shows faintly at rest
 * and a mouse only on hover (#7040, decision 44).
 */
async function imageCues(
  page: Page,
  open: (page: Page, title: string) => Promise<void>,
): Promise<{ hint: Locator; handle: Locator }> {
  await attachFile(page, SEED_IDS.BLOCK_GS_1, 'photo.png', 'image/png', PNG_1X1)
  await open(page, 'Getting Started')
  await expect(page.locator('img[alt="photo.png"]')).toBeVisible()
  await page.mouse.move(0, 0)
  return {
    hint: page.getByTestId('image-resize-hint'),
    handle: page.getByTestId('image-resize-handle'),
  }
}

test.describe('the desktop app with a coarse pointer @mobile @pages @editor @attachments', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isTauri', { value: true })
    })
  })

  test('lays out for a mouse: row actions hidden at rest, desktop indent-guide reach and control lane', async ({
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
    await expect(deleteButton).toHaveCSS('width', '24px')

    await openPage(page, 'Quick Notes')
    const guideReach = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.height = 'var(--block-row-gap)'
      document.body.append(probe)
      const height = getComputedStyle(probe).height
      probe.remove()
      return height
    })
    expect(guideReach).toBe('4px')
    await expect(page.locator('.block-control-lane').first()).toBeAttached()
  })

  test('keeps its controls mouse-sized', async ({ page }) => {
    await waitForBoot(page)
    expect(await touchSizes(page, openPage)).toEqual({
      listRow: '0px',
      iconButton: '32px',
      menuRow: '0px',
    })
  })

  test('keeps an image’s resize cues hidden at rest', async ({ page }) => {
    await waitForBoot(page)
    const { hint, handle } = await imageCues(page, openPage)
    await expect(hint).toHaveCSS('opacity', '0')
    await expect(handle).toHaveCSS('opacity', '0')
  })
})

// The other arm: a browser on a touch phone still gets 44 px from the same classes.
test.describe('a touch phone @mobile @pages @editor @attachments', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('sizes the same controls for a finger', async ({ page }) => {
    await waitForBoot(page)
    expect(await touchSizes(page, openPageMobile)).toEqual({
      listRow: '44px',
      iconButton: '44px',
      menuRow: '44px',
    })
  })

  test('shows an image’s resize cues faintly at rest', async ({ page }) => {
    await waitForBoot(page)
    const { hint, handle } = await imageCues(page, openPageMobile)
    await expect(hint).toHaveCSS('opacity', '0.5')
    await expect(handle).toHaveCSS('opacity', '0.6')
  })
})
