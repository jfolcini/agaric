/**
 * #5369 — Settings › Appearance › Font size scales a block's text together
 * with its row controls (the task checkbox, the due-date chip's icon), keeps
 * Medium at today's pixels, and leaves the app chrome (a sidebar icon) fixed.
 * This is geometry, which happy-dom cannot measure.
 */

import type { Locator } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

const PAGE = 'Projects'
const TASK = 'Fix login bug'
/** `FONT_SIZE_PX` in `src/hooks/useFontSize.ts`. */
const TEXT_PX = { small: 14, medium: 16, large: 18 } as const
/** Today's sizes at Medium: the 16px checkbox and the 14px chip icon. */
const MEDIUM = { text: 16, checkbox: 16, chipIcon: 14 } as const
/** The sidebar nav icon: the nav row's `size-4`, chrome, the same at every setting. */
const SIDEBAR_ICON_PX = 16

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'element must have a layout box').not.toBeNull()
  return box?.width ?? Number.NaN
}

for (const [size, textPx] of Object.entries(TEXT_PX)) {
  test.describe(`font size ${size}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem('agaric-font-size', s), size)
      await waitForBoot(page)
      await openPage(page, PAGE)
    })

    test('row controls keep their ratio to the block text; the sidebar does not move', async ({
      page,
    }, testInfo) => {
      const row = page.locator('[data-testid="sortable-block"]', { hasText: TASK })
      const text = row.getByTestId('block-static')
      await expect(text).toBeVisible()
      expect(await text.evaluate((el) => getComputedStyle(el).fontSize)).toBe(`${textPx}px`)

      const scale = textPx / MEDIUM.text
      const checkbox = await width(row.getByTestId('task-checkbox-doing'))
      expect(checkbox, 'checkbox').toBeCloseTo(MEDIUM.checkbox * scale, 1)
      const chipIcon = await width(row.getByRole('button', { name: /^Due / }).locator('svg'))
      expect(chipIcon, 'due-date chip icon').toBeCloseTo(MEDIUM.chipIcon * scale, 1)

      const sidebarIcon = page
        .locator('[data-slot="sidebar"]')
        .getByRole('button', { name: 'Pages', exact: true })
        .locator('svg')
      expect(await width(sidebarIcon), 'sidebar icon').toBeCloseTo(SIDEBAR_ICON_PX, 1)

      if (size === 'large') {
        await testInfo.attach('page-at-large', {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
      }
    })
  })
}
