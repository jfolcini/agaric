import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Loading more rows is not a new list: the Pages list cursor keeps its row and
 * the list stays where it was scrolled. Reset to row 0, the cursor dragged the
 * list back to the top on every load-more.
 */
test('the list cursor and scroll position survive a load-more @pages', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockExtraPages', '120'))
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  const grid = page.getByRole('grid')
  const rows = grid.locator('[data-page-item]')
  await expect(rows.first()).toBeVisible()
  const rowIds = await rows.evaluateAll((els) =>
    els
      .toSorted(
        (a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')),
      )
      .map((el) => el.id),
  )

  await grid.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown')
  await expect(grid).toHaveAttribute('aria-activedescendant', rowIds[5] ?? '')

  const loaded = page.getByText(/^Loaded \d+ more pages$/)
  await expect(loaded).toHaveCount(0)
  const bottom = await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
  expect(bottom).toBeGreaterThan(0)
  await expect(loaded).toHaveCount(1)
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(bottom)

  await page.keyboard.press('ArrowDown')
  await expect(grid).toHaveAttribute('aria-activedescendant', rowIds[6] ?? '')
})
