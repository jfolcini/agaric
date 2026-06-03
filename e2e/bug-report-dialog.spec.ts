/**
 * E2E — Report-a-bug dialog body scrolls when its content overflows.
 *
 * Regression for the dialog overflow bug: `DialogContent` is bounded by
 * `max-height` only, so its height is content-driven and NOT "definite".
 * A percentage `h-full` on the Radix scroll viewport therefore fell back
 * to `auto` and grew to content height, overflowing (and being clipped
 * by) the body's flex-sized Root — the lower part of the form (logs list,
 * confirmation checkbox, footer) was cut off with no way to scroll to it.
 *
 * The fix makes the viewport a flex child (`flex-auto min-h-0`) of a
 * flex-column Root so it shrinks below its content and scrolls. This test
 * forces overflow with a short window and asserts the body actually
 * scrolls.
 */

import { expect, test } from './helpers'

test.describe('Report-a-bug dialog', () => {
  test('body scrolls when content overflows a short window', async ({ page }) => {
    // A short window guarantees the dialog content exceeds the available
    // height regardless of how much of the form is expanded.
    await page.setViewportSize({ width: 900, height: 480 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()

    // The dialog is mounted at App level and listens for this event.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('agaric:report-bug', { detail: { message: 'overflow probe' } }),
      )
    })

    const body = page.getByTestId('bug-report-body')
    await expect(body).toBeVisible()

    const viewport = body.locator('[data-slot="scroll-area-viewport"]').first()

    // Content must overflow the viewport (otherwise the test proves nothing).
    const { clientHeight, scrollHeight } = await viewport.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }))
    expect(scrollHeight).toBeGreaterThan(clientHeight)

    // And it must actually scroll — the bug was that scrollTop stayed pinned
    // at 0 because the viewport grew to content height instead of clipping.
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const scrolled = await viewport.evaluate((el) => el.scrollTop)
    expect(scrolled).toBeGreaterThan(0)
  })

  test('body content does not overflow horizontally', async ({ page }) => {
    // Regression: Radix's ScrollArea viewport wraps children in a
    // `display:table` div that shrink-wraps to content width, so the form
    // controls (inputs, textarea, preview) ran off the right edge with no
    // wrap and — vertical-only scroller — no horizontal scrollbar.
    await page.setViewportSize({ width: 900, height: 800 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('agaric:report-bug', { detail: { message: 'overflow probe' } }),
      )
    })

    const body = page.getByTestId('bug-report-body')
    await expect(body).toBeVisible()
    const viewport = body.locator('[data-slot="scroll-area-viewport"]').first()

    const { clientWidth, scrollWidth } = await viewport.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }))
    // No horizontal overflow: content fits the viewport width (allow 1px
    // sub-pixel rounding).
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1)
  })
})
