import { type CDPSession, devices, type Page } from '@playwright/test'

import { expect, focusBlock, test, waitForBoot } from './helpers'

/**
 * #6790 — on Android the keyboard shrinks only the visual viewport, so with it
 * up the screen is a window panned over the full-height layout, and the top of
 * the page comes back only when a swipe at the top of `#main-content` pans that
 * window. The browser has no on-screen keyboard: a page scale of 840 / 520
 * gives the visual viewport the height it had on the Pixel 8 with the keyboard
 * up, and focusing the last block pans it down as the keyboard did.
 */

const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7']

const LINES = 23

async function swipeDown(page: Page, cdp: CDPSession): Promise<void> {
  // The right-hand side of the content, clear of the blocks' own gestures.
  const x = (await page.evaluate(() => window.visualViewport?.width ?? 0)) - 20
  const steps = 12
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 150 }] })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 150 + (250 * i) / steps }],
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await settled(page)
}

/** The visual viewport's pan and the content's scroll, once neither has moved for ten frames. */
function settled(page: Page): Promise<{ offsetTop: number; scrollTop: number }> {
  return page.evaluate(
    () =>
      new Promise<{ offsetTop: number; scrollTop: number }>((resolve) => {
        const read = () => ({
          offsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
          scrollTop: Math.round(document.getElementById('main-content')?.scrollTop ?? -1),
        })
        let last = read()
        let still = 0
        const tick = () => {
          const now = read()
          still =
            now.offsetTop === last.offsetTop && now.scrollTop === last.scrollTop ? still + 1 : 0
          last = now
          if (still >= 10) resolve(now)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
}

test.describe('the top of a long page with the keyboard up (#6790) @mobile @editor @journal', () => {
  test.use(pixel7)

  test('swiping down at the top of the content pans the screen back to the first line', async ({
    page,
  }) => {
    await waitForBoot(page)
    await focusBlock(page, 0)
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('line 1')
    for (let i = 2; i <= LINES; i++) {
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.keyboard.type(`line ${i}`)
    }
    await expect(editor).toHaveText(`line ${LINES}`)

    const cdp = await page.context().newCDPSession(page)
    const height = await page.evaluate(() => window.innerHeight)
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: height / 520 })
    await expect.poll(async () => (await settled(page)).offsetTop).toBeGreaterThan(0)

    // The first swipes scroll the content to its top; the ones after pan.
    for (let i = 0; i < 6; i++) await swipeDown(page, cdp)
    expect(await settled(page)).toEqual({ offsetTop: 0, scrollTop: 0 })

    const firstLine = page.locator('[data-testid="block-static"]', { hasText: /^line 1$/ })
    const top = await firstLine.evaluate((el) => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(0)
    await expect(editor).toHaveText(`line ${LINES}`)
  })
})
