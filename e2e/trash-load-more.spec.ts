import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * Load more in the virtualised Trash list leaves both the list's scroll and
 * the keyboard cursor where they were.
 */
test('Load more leaves the Trash list where the wheel scrolled it @pages', async ({ page }) => {
  await waitForBoot(page)
  // Past one 50-root page, so Load more has a second page to append.
  const ids = await seedSearchBlocks(
    page,
    Array.from({ length: 60 }, (_, i) => ({ content: `Trashed row ${i}` })),
  )
  await page.evaluate(async (blockIds) => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    for (const blockId of blockIds) await invoke('delete_block', { blockId })
  }, ids)

  await navigateToView(page, 'Trash')
  const grid = page.getByRole('grid', { name: 'Trash items' })
  const row = (index: number) => grid.locator(`[data-testid="trash-item"][data-index="${index}"]`)
  // A clicked row takes the cursor; Load more must neither move it nor scroll to it.
  await row(2).click()
  await expect(row(2)).toHaveClass(/\blist-cursor\b/)

  await grid.hover()
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400)
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)
  const scrolled = await grid.evaluate((el) => el.scrollTop)

  const loadMore = page.getByRole('button', { name: 'Load more' })
  await loadMore.click()
  await expect(loadMore).toBeHidden()
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(scrolled)

  await grid.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(row(2)).toHaveClass(/\blist-cursor\b/)
  await expect(grid.locator('.list-cursor')).toHaveCount(1)
})
