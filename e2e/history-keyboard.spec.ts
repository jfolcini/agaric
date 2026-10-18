import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * Keyboard cursor in the History list (#5737).
 *
 * The list is virtualised, so a jump (End, PageDown) lands on a row the
 * window has not mounted yet. Each step asserts the cursor row exists, is the
 * only one, and is scrolled into view.
 */

/** `create_block` logs one op each, so the list outgrows the mounted window. */
const SEEDED_BLOCKS = 14

test('j / k / Home / End / PageUp / PageDown keep the cursor row in view @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  await seedSearchBlocks(
    page,
    Array.from({ length: SEEDED_BLOCKS }, (_, i) => ({ content: `History row ${i}` })),
  )
  const total = await page.evaluate(async () => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const res = (await invoke('list_page_history', {
      pageId: '__all__',
      opTypeFilter: null,
      scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
      cursor: null,
      limit: 50,
    })) as { items: unknown[]; has_more: boolean }
    // One page, so End's target is loaded without a load-more.
    return res.has_more ? -1 : res.items.length
  })
  expect(total).toBeGreaterThanOrEqual(SEEDED_BLOCKS)

  await navigateToView(page, 'History')
  const grid = page.getByRole('grid', { name: 'History entries' })
  await expect(grid.getByTestId('history-item-0')).toBeVisible()

  // The cursor is exposed only as the `list-cursor` class on its row.
  const expectCursorAt = async (index: number) => {
    const row = grid.getByTestId(`history-item-${index}`)
    await expect(row).toHaveClass(/\blist-cursor\b/)
    await expect(row).toBeInViewport()
    await expect(grid.locator('.list-cursor')).toHaveCount(1)
  }

  await expectCursorAt(0)
  await page.keyboard.press('j')
  // A navigation key moves DOM focus onto the list, so later keys reach it too.
  await expect(grid).toBeFocused()
  await expectCursorAt(1)
  await page.keyboard.press('j')
  await expectCursorAt(2)
  await page.keyboard.press('k')
  await expectCursorAt(1)
  await page.keyboard.press('End')
  await expectCursorAt(total - 1)
  await page.keyboard.press('Home')
  await expectCursorAt(0)
  await page.keyboard.press('PageDown')
  await expectCursorAt(10)
  await page.keyboard.press('PageUp')
  await expectCursorAt(0)
})

test('Load more leaves the list where the wheel scrolled it @pages', async ({ page }) => {
  await waitForBoot(page)
  // Past one 50-entry page, so Load more has a second page to append.
  await seedSearchBlocks(
    page,
    Array.from({ length: 60 }, (_, i) => ({ content: `History row ${i}` })),
  )
  await navigateToView(page, 'History')
  const grid = page.getByRole('grid', { name: 'History entries' })
  // A clicked row takes the cursor; Load more must neither move it nor scroll to it.
  await grid.getByTestId('history-item-2').click()
  await expect(grid.getByTestId('history-item-2')).toHaveClass(/\blist-cursor\b/)

  await grid.hover()
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400)
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)
  const scrolled = await grid.evaluate((el) => el.scrollTop)

  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByText(/Loaded \d+ more/)).toBeAttached()
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(scrolled)
})
