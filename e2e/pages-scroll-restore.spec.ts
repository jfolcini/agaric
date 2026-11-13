import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/** The title of the page row whose top sits nearest below `fromTop` px into the Pages list. */
async function rowBelow(page: Page, fromTop: number) {
  return page.getByRole('grid').evaluate((grid, from) => {
    const top = grid.getBoundingClientRect().top + from
    let best: { title: string; at: number } | null = null
    for (const row of grid.querySelectorAll<HTMLElement>('[data-page-item]')) {
      const at = row.getBoundingClientRect().top
      if (at >= top && (best == null || at < best.at)) {
        best = {
          title: row.querySelector('.page-browser-item-title')?.getAttribute('title') ?? '',
          at,
        }
      }
    }
    return best == null ? null : { title: best.title, offset: Math.round(best.at - top) }
  }, fromTop)
}

/**
 * Coming back to the Pages list puts it where the user left it. The list is
 * still cached then (#5446), so it renders whole on the first frame, and the
 * saved offset has to survive that mount rather than wait for a fetch. The
 * page's own scroll restore (`scroll-restore.spec.ts`) is another scroller.
 */
test('returning to Pages restores where the list was scrolled @pages', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockExtraPages', '120'))
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  const grid = page.getByRole('grid')
  await expect(grid.locator('[data-page-item]').first()).toBeVisible()

  // Past the first result page: the list loads more as it scrolls.
  await expect
    .poll(() =>
      grid.evaluate((el) => {
        el.scrollTop = 4000
        return el.scrollTop
      }),
    )
    .toBe(4000)
  // The offset is saved a debounce after the last scroll event.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(sessionStorage).find(([k]) => k.startsWith('pageBrowser:scrollOffset:')),
      ),
    )
    .toEqual([expect.any(String), '4000'])
  const left = await rowBelow(page, 0)
  expect(left?.title).toMatch(/^Bulk Page \d+$/)

  // A row mid-list, which a click opens without scrolling the list first.
  const open = await rowBelow(page, 200)
  await grid.getByText(open?.title ?? '', { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(open?.title ?? '')
  await navigateToView(page, 'Pages')
  await expect(grid.locator('[data-page-item]').first()).toBeVisible()

  await expect.poll(() => rowBelow(page, 0)).toEqual(left)
})
