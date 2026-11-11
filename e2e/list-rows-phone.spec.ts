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
    await expect(content).toBeVisible()
    const [badgeBox, resetBox, contentBox] = await Promise.all([
      badge.boundingBox(),
      reset.boundingBox(),
      content.boundingBox(),
    ])
    if (!badgeBox || !resetBox || !contentBox) throw new Error('row parts are not laid out')
    // Reset sits on the badge's line, and the content takes a line of its own
    // below it, starting at the badge's left edge.
    expect(resetBox.y).toBeLessThan(contentBox.y)
    expect(contentBox.y).toBeGreaterThanOrEqual(badgeBox.y + badgeBox.height - 1)
    expect(Math.abs(contentBox.x - badgeBox.x)).toBeLessThanOrEqual(1)
    expect(
      Math.abs(resetBox.y + resetBox.height / 2 - (badgeBox.y + badgeBox.height / 2)),
    ).toBeLessThanOrEqual(resetBox.height / 2)
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
