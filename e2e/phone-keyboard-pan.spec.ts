import { type CDPSession, devices, type Page } from '@playwright/test'

import { expect, focusBlock, test, waitForBoot } from './helpers'

/**
 * #6790 — on Android the on-screen keyboard shrinks the layout viewport: the
 * webview ends at the keyboard's top (`MainActivity.kt`). So a long page has
 * one scroll level with the keyboard up, the content's, and reaching its top
 * shows the header and the first line; the visual viewport never pans. The
 * browser has no on-screen keyboard: shrinking the viewport by the Pixel 8's
 * 320 px keyboard is what the webview now sees when it opens.
 */

const { defaultBrowserType: _, ...pixel7 } = devices['Pixel 7']

const LINES = 23
const KEYBOARD = 320
/** Text that wraps the last line onto three more. */
const WRAPPING = ' and on,'.repeat(16)

async function swipeDown(page: Page, cdp: CDPSession): Promise<void> {
  // The right-hand side of the content, clear of the blocks' own gestures.
  const x = (await page.evaluate(() => window.innerWidth)) - 20
  const steps = 12
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 150 }] })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 150 + (250 * i) / steps }],
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
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

/** The bottom of the caret, and the top of the toolbar pinned on the keyboard. */
function caretAndToolbar(page: Page): Promise<{ caret: number; toolbar: number }> {
  return page.evaluate(() => {
    const caret = window.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom
    const bar = document.querySelector('[data-testid="formatting-toolbar"][data-pinned]')
    return { caret: caret ?? Infinity, toolbar: bar?.getBoundingClientRect().top ?? -Infinity }
  })
}

test.describe('a long page with the keyboard up (#6790) @mobile @editor @journal', () => {
  test.use(pixel7)

  test('the caret stays above the keyboard, and one scroll reaches the header', async ({
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

    const { width, height } = pixel7.viewport
    await page.setViewportSize({ width, height: height - KEYBOARD })
    await settled(page)
    // The keyboard opening leaves the caret on screen, above the toolbar pinned
    // on the keyboard, and so does typing on past the end of the line.
    const opened = await caretAndToolbar(page)
    expect(opened.caret, 'caret bottom vs the toolbar top').toBeLessThanOrEqual(opened.toolbar)
    await page.keyboard.type(WRAPPING)
    await expect(editor).toHaveText(`line ${LINES}${WRAPPING}`)
    const typed = await caretAndToolbar(page)
    expect(typed.caret, 'caret bottom vs the toolbar top').toBeLessThanOrEqual(typed.toolbar)

    const cdp = await page.context().newCDPSession(page)
    for (let i = 0; i < 4; i++) {
      await swipeDown(page, cdp)
      expect((await settled(page)).offsetTop, 'the screen never pans').toBe(0)
    }
    expect(await settled(page)).toEqual({ offsetTop: 0, scrollTop: 0 })

    const header = await page.locator('header').first().boundingBox()
    const firstLine = page.locator('[data-testid="block-static"]', { hasText: /^line 1$/ })
    const top = await firstLine.evaluate((el) => el.getBoundingClientRect().top)
    expect(header?.y, 'header top').toBe(0)
    expect(top).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0))
    await expect(editor).toHaveText(`line ${LINES}${WRAPPING}`)
  })
})
