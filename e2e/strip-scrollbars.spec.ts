/**
 * The tab bar, the recent pages strip and a narrow window's Pages filter row
 * scroll sideways only when they overflow, so while they fit they keep no
 * empty native scrollbar under them (#6053). The app turns the native bars back
 * on (index.css), so the browser's must stay visible here.
 */
import type { Locator } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

/** The scroll viewport around `content`: its horizontal scrollbar's box, and its overflow. */
function bars(content: Locator) {
  return content.evaluate((el) => {
    const viewport = el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) throw new Error('no scroll viewport')
    return {
      barHeight: viewport.offsetHeight - viewport.clientHeight,
      overflowX: viewport.scrollWidth - viewport.clientWidth,
    }
  })
}

test('the tab bar, the recents strip and the filter row keep no scrollbar while they fit @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  // Two pages, so the recents strip holds the one not on screen.
  for (const title of ['Projects', 'Getting Started']) {
    await navigateToView(page, 'Pages')
    await page.getByText(title, { exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  }
  await page.keyboard.down('Control')
  await page.keyboard.press('t')
  await page.keyboard.up('Control')
  await expect(page.getByRole('tab')).toHaveCount(2)

  const tabs = await bars(page.getByRole('tablist'))
  const recents = await bars(
    page.getByTestId('quick-access-bar').locator('[data-slot="scroll-area-viewport"]'),
  )
  // Below the phone breakpoint the filter row scrolls sideways, a mouse window's too.
  await page.setViewportSize({ width: 700, height: 900 })
  await navigateToView(page, 'Pages')
  const filters = await bars(page.getByTestId('page-browser-filter-row'))

  const fits = { barHeight: 0, overflowX: 0 }
  expect({ tabs, recents, filters }).toEqual({ tabs: fits, recents: fits, filters: fits })
})
