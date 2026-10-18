import { expect, focusBlock, test, typeSlashCommand, waitForBoot } from './helpers'

/**
 * A date page created from a block's `/date` picker reaches the open journal:
 * navigating to that day shows its page, not "No blocks for". The journal's
 * mounted page map re-fetches only on an invalidation, a range change or a
 * remount, so without one the day stayed empty for as long as the journal
 * stayed on that month.
 *
 * In `e2e/` because the page-dates cache and the journal's page map are
 * frontend state the mock lane runs for real.
 */

// A Wednesday; the seed has a journal page for today only.
const NOW = new Date('2026-10-14T10:00:00')
const TARGET = '2026-10-16'

test('a date page created from the block date picker shows in Day mode @editor @pages @journal', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW)
  await waitForBoot(page)
  await page.getByRole('tab', { name: 'Daily view' }).click()

  await focusBlock(page)
  await typeSlashCommand(page, 'date')
  await page.keyboard.press('Enter')
  const popup = page.getByTestId('date-picker-popup')
  await expect(popup).toBeVisible()
  await popup.locator(`[role="gridcell"][data-day="${TARGET}"] button`).click()
  await expect(popup).toBeHidden()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Next day' }).click()
  const day = page.locator(`section[id="journal-${TARGET}"]`)
  await expect(day.getByTestId('block-tree')).toBeVisible()
  await expect(day.getByText('No blocks for')).toHaveCount(0)
})
