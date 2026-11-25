import { devices, type Locator, type Page } from '@playwright/test'

import { createPageFromPagesView, expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Geometry guard for the list-row pattern (`listRowVariants`,
 * `src/components/ui/list-item.tsx`): on a phone, rows of a table-like
 * list sit flush, told apart by an inset divider rather than a gap or a
 * card per row, and each is at least a 44px touch target.
 *
 * jsdom has no layout engine, so this cannot live in a vitest file.
 */

const iPhone13 = devices['iPhone 13']

/** Below a pixel is subpixel layout, not a gap. */
const FLUSH_TOLERANCE_PX = 1
const TOUCH_TARGET_PX = 44

async function boxes(rows: Locator): Promise<{ top: number; bottom: number; height: number }[]> {
  return rows.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height }
    }),
  )
}

async function expectFlushTouchRows(rows: Locator, atLeast: number): Promise<void> {
  await expect(rows.nth(atLeast - 1)).toBeVisible()
  const measured = (await boxes(rows)).toSorted((a, b) => a.top - b.top)
  expect(measured.length).toBeGreaterThanOrEqual(atLeast)
  for (const row of measured) expect(row.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX)
  for (let i = 1; i < measured.length; i++) {
    const gap = (measured[i]?.top ?? 0) - (measured[i - 1]?.bottom ?? 0)
    expect(Math.abs(gap)).toBeLessThanOrEqual(FLUSH_TOLERANCE_PX)
  }
}

async function openPagesView(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await expect(page.getByRole('grid')).toBeVisible()
}

test.describe('List rows on a phone @pages @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Pages rows sit flush and are touch-sized', async ({ page }) => {
    await openPagesView(page)
    await expectFlushTouchRows(page.locator('[data-page-item]'), 5)
  })

  test('History rows sit flush and are touch-sized', async ({ page }) => {
    // Two edits give the history list more than one row.
    await openPagesView(page)
    await createPageFromPagesView(page, 'Row one')
    await openPagesView(page)
    await createPageFromPagesView(page, 'Row two')
    await navigateToView(page, 'History')
    await expectFlushTouchRows(page.locator('[data-history-item]'), 3)
  })

  // Reset used to wrap onto a line of its own under the content, making every
  // row three lines tall; it now shares the meta line, the content under it.
  test('a History row keeps its Reset action on the meta line, above the content', async ({
    page,
  }) => {
    await openPagesView(page)
    await createPageFromPagesView(page, 'Row one')
    await navigateToView(page, 'History')
    const row = page.locator('[data-history-item]').filter({ hasText: 'Row one' }).first()
    const badge = row.getByTestId('history-type-badge')
    const reset = row.getByRole('button', { name: 'Reset to this point' })
    const content = row.locator('.history-item-preview')
    const device = row.locator('.history-item-device-group')
    await expect(content).toBeVisible()
    const [badgeBox, resetBox, contentBox, deviceBox] = await Promise.all([
      badge.boundingBox(),
      reset.boundingBox(),
      content.boundingBox(),
      device.boundingBox(),
    ])
    if (!badgeBox || !resetBox || !contentBox || !deviceBox) {
      throw new Error('row parts are not laid out')
    }
    // Reset sits on the badge's line, and the content takes a line of its own
    // below it, starting at the badge's left edge.
    expect(resetBox.y).toBeLessThan(contentBox.y)
    expect(contentBox.y).toBeGreaterThanOrEqual(badgeBox.y + badgeBox.height - 1)
    expect(Math.abs(contentBox.x - badgeBox.x)).toBeLessThanOrEqual(1)
    // Two lines, not three: the device id trails the content line instead of
    // wrapping onto a line of its own under the badge.
    const deviceCenter = deviceBox.y + deviceBox.height / 2
    expect(deviceCenter).toBeGreaterThanOrEqual(contentBox.y)
    expect(deviceCenter).toBeLessThanOrEqual(contentBox.y + contentBox.height)
    expect(
      Math.abs(resetBox.y + resetBox.height / 2 - (badgeBox.y + badgeBox.height / 2)),
    ).toBeLessThanOrEqual(resetBox.height / 2)
  })

  // A row without content showed "· This device" alone on a second line (#7040).
  test('a History row without content is one line, its device on the meta line', async ({
    page,
  }) => {
    await openPagesView(page)
    await createPageFromPagesView(page, 'Row one')
    await navigateToView(page, 'History')
    // The new page's first block is created empty.
    const row = page
      .locator('[data-history-item]')
      .filter({ hasNot: page.locator('.history-item-preview') })
      .first()
    const badge = row.getByTestId('history-type-badge')
    const device = row.locator('.history-item-device-group')
    await expect(device).toBeVisible()
    const [badgeBox, deviceBox] = await Promise.all([badge.boundingBox(), device.boundingBox()])
    if (!badgeBox || !deviceBox) throw new Error('row parts are not laid out')
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2
    expect(Math.abs(middle(deviceBox) - middle(badgeBox))).toBeLessThanOrEqual(1)
    expect(deviceBox.x).toBeGreaterThan(badgeBox.x + badgeBox.width)
  })

  // The cursor's accent bar used to be an inset box-shadow, which the card's
  // rounded corner bent into a curve on an end row. The bar now runs the row's
  // full height, and the card squares that corner while the cursor sits in it.
  test("the cursor bar meets the card's corner square on its first row", async ({ page }) => {
    await openPagesView(page)
    await createPageFromPagesView(page, 'Row one')
    await navigateToView(page, 'History')
    const grid = page.getByRole('grid')
    await expect(grid.locator('[data-history-item]').nth(2)).toBeVisible()
    const card = page.locator('[data-slot="scroll-area"]').filter({ has: grid })
    await grid.focus()
    // At rest the cursor sits on the first row unpainted, so the corner stays round.
    await expect(card).toHaveCSS('border-top-left-radius', '8px')
    await page.keyboard.press('Home')
    const row = grid.locator('.list-cursor')
    await expect(row).toHaveCount(1)
    const m = await row.evaluate((el) => {
      const bar = getComputedStyle(el, '::before')
      const c = el.closest('[data-slot="scroll-area"]') as HTMLElement
      return {
        content: bar.content,
        width: bar.width,
        top: bar.top,
        bottom: bar.bottom,
        rowTop: el.getBoundingClientRect().top,
        cardTop: c.getBoundingClientRect().top + parseFloat(getComputedStyle(c).borderTopWidth),
      }
    })
    // The row sits in the card's corner, so the corner would clip the bar.
    expect(Math.abs(m.rowTop - m.cardTop)).toBeLessThanOrEqual(FLUSH_TOLERANCE_PX)
    expect([m.content, m.width, m.top, m.bottom]).toEqual(['""', '2px', '0px', '0px'])
    await expect(card).toHaveCSS('border-top-left-radius', '0px')
    await expect(card).toHaveCSS('border-top-right-radius', '8px')
    // Off the end row, the corner is round again.
    await page.keyboard.press('ArrowDown')
    await expect(card).toHaveCSS('border-top-left-radius', '8px')
  })

  // The touch ↑/↓ pill floats at the bottom of the view; the last row must
  // clear it once the list is scrolled to its end (#7040).
  test.describe('on a 412×915 phone', () => {
    test.use({ viewport: { width: 412, height: 915 } })

    test('the History ↑/↓ pill covers no row at the end of the list', async ({ page }) => {
      for (const title of ['Row one', 'Row two', 'Row three', 'Row four']) {
        await openPagesView(page)
        await createPageFromPagesView(page, title)
      }
      await navigateToView(page, 'History')
      const grid = page.getByRole('grid')
      const pill = page.getByTestId('history-touch-nav')
      await expect(pill).toBeVisible()
      // The list overflows its scroller, so its end is not in view yet.
      expect(await grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      // Scrolled to the end on every read: the list grows as the virtualizer
      // measures rows taller than its estimate. Read once the final row is
      // mounted (its bottom is the full-height spacer's) and the list is at its end.
      await expect
        .poll(() =>
          grid.evaluate((el) => {
            el.scrollTop = el.scrollHeight
            const rows = [...el.querySelectorAll<HTMLElement>('[data-history-item]')]
            const spacer = rows[0]?.parentElement
            const last = rows.toSorted(
              (a, b) => Number(b.dataset.index) - Number(a.dataset.index),
            )[0]
            const pillEl = document.querySelector('[data-testid="history-touch-nav"]')
            if (!spacer || !last || !pillEl) return 'not laid out'
            const row = last.getBoundingClientRect()
            const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
            if (!atEnd || Math.abs(row.bottom - spacer.getBoundingClientRect().bottom) > 1) {
              return 'not at end'
            }
            const pillBox = pillEl.getBoundingClientRect()
            return row.bottom <= pillBox.top || pillBox.bottom <= row.top ? 'clear' : 'covered'
          }),
        )
        .toBe('clear')
    })
  })

  test('Tags rows sit flush and are touch-sized', async ({ page }) => {
    await navigateToView(page, 'Tags')
    await expectFlushTouchRows(page.locator('[data-slot="list-item"]'), 3)
  })

  test('a list is one card, and its last row draws no divider against it', async ({ page }) => {
    await navigateToView(page, 'Tags')
    const rows = page.locator('[data-slot="list-item"]')
    await expect(rows.nth(2)).toBeVisible()
    const card = page.locator('[data-slot="scroll-area"]').filter({ has: rows.first() })
    await expect(card).toHaveCSS('border-top-width', '1px')
    await expect(card).toHaveCSS('border-top-left-radius', '8px')
    const divider = (el: Element) => getComputedStyle(el, '::after').content
    expect(await rows.first().evaluate(divider)).not.toBe('none')
    expect(await rows.last().evaluate(divider)).toBe('none')
  })
})
