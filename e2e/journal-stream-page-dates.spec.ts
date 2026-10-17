import { expect, test, waitForBoot } from './helpers'

/**
 * A journal page created in Stream mode reaches the rest of the journal: Day
 * mode shows that day's block, and the date picker dots it. Before the fix
 * Stream kept the new page to itself, so Day mode showed "No blocks for" the
 * day and the picker had no dot until the page-dates cache's TTL ran out,
 * which the pinned clock never reaches.
 *
 * In `e2e/` because the page-dates cache and the journal's page map are
 * frontend state the mock lane runs for real.
 */

// A Wednesday; the seed has a journal page for today only.
const NOW = new Date('2026-10-14T10:00:00')
const YESTERDAY = '2026-10-13'

test('a page created in Stream shows in Day mode and in the date picker', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await waitForBoot(page)

  await page.getByRole('tab', { name: 'Continuous stream view' }).click()
  const streamDay = page.locator(
    `[data-testid="journal-stream"] section[id="journal-${YESTERDAY}"]`,
  )
  await streamDay.getByRole('button', { name: 'Add block', exact: true }).click()
  const editor = streamDay.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeFocused()
  await editor.pressSequentially('lichen tally', { delay: 10 })
  await expect(editor).toHaveText('lichen tally')
  await page.keyboard.press('Escape')
  await expect(streamDay.locator('[data-testid="block-static"]')).toHaveText(['lichen tally'])

  await page.getByRole('tab', { name: 'Daily view' }).click()
  await page.getByRole('button', { name: 'Previous day' }).click()
  const day = page.locator(`section[id="journal-${YESTERDAY}"]`)
  await expect(day.locator('[data-testid="block-static"]')).toHaveText(['lichen tally'])
  await expect(day.getByText('No blocks for')).toHaveCount(0)

  await page.getByRole('button', { name: /Open calendar picker$/ }).click()
  const picker = page.getByRole('dialog', { name: 'Date picker' })
  await expect(picker).toHaveAttribute('aria-busy', 'false')
  const dots = picker
    .locator(`[role="gridcell"][data-day="${YESTERDAY}"]`)
    .getByTestId('calendar-dots')
  await expect(dots.locator('span.bg-primary')).toHaveCount(1)
})
