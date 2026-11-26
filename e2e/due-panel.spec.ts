import type { Page } from '@playwright/test'

import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * #5735: the Due panel's tabs on today's page and another day's list (#7155),
 * and its overdue rows (the "(Xd overdue)" label and the click that opens the
 * task on its page). Both are frontend behaviour over rows the mock serves as
 * the backend does (`list_blocks` agenda date, `query_by_property` on
 * `todo_state`), so the mock lane can show either one failing.
 *
 * The clock is pinned so "today", "3 days ago" and "next week" are fixed dates
 * and the day count never straddles a DST change or a month boundary by luck.
 */

const TODAY = new Date('2026-10-14T10:00:00')

/** Leave and re-enter the journal so the Due panel refetches what a spec seeded. */
async function refetchDuePanel(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: TODAY })
  await waitForBoot(page)
})

test('today’s tabs list a task under its date’s tab, and a past day lists its own tasks @journal', async ({
  page,
}) => {
  // Dates are days from the pinned today (a Wednesday); the blocks land under
  // the seeded Projects page.
  await seedSearchBlocks(page, [
    { content: 'Plan the offsite', todo: 'TODO', scheduled: 2 },
    { content: 'Book the venue', todo: 'TODO', due: 9 },
    { content: 'Renew passport', todo: 'TODO', due: -3 },
  ])
  await refetchDuePanel(page)

  const panel = page.getByTestId('due-panel')
  const rows = panel.getByTestId('due-panel-item')
  await expect(panel.getByRole('switch')).toHaveCount(0)
  await panel.getByRole('tab', { name: /^This week \d+$/ }).click()
  await expect(rows.filter({ hasText: 'Plan the offsite' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Book the venue' })).toHaveCount(0)
  await panel.getByRole('tab', { name: /^Later \d+$/ }).click()
  await expect(rows.filter({ hasText: 'Book the venue' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Plan the offsite' })).toHaveCount(0)

  // Three days back: no tabs, just that day's own task.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.getByRole('tab')).toHaveCount(0)
  await expect(rows).toHaveText([/Renew passport/])
})

test('an overdue task reads "(3d overdue)" and a click opens it focused on its page @journal', async ({
  page,
}) => {
  const [id] = await seedSearchBlocks(page, [{ content: 'Renew passport', todo: 'TODO', due: -3 }])
  await refetchDuePanel(page)

  const row = page
    .getByTestId('due-panel')
    .getByTestId('due-panel-item')
    .filter({ hasText: 'Renew passport' })
  await expect(row).toContainText('(3d overdue)')

  await row.click()
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveText('Projects')
  const editor = page.locator(
    `[data-block-id="${id}"] [data-testid="block-editor"] [contenteditable="true"]`,
  )
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('Renew passport')
})
