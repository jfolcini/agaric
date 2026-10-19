import type { Page } from '@playwright/test'

import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * #5735: the Due panel's hide-before-scheduled toggle and its overdue rows
 * (the "(Xd overdue)" label and the click that opens the task on its page).
 * Both are frontend behaviour over rows the mock serves as the backend does
 * (`list_blocks` agenda date, `query_by_property` on `due_date`), so the mock
 * lane can show either one failing.
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

test('hide-before-scheduled hides a task scheduled next week and shows it again @journal', async ({
  page,
}) => {
  // Dates are days from the pinned today; the blocks land under the seeded Projects page.
  await seedSearchBlocks(page, [
    { content: 'Plan the offsite', todo: 'TODO', due: 0, scheduled: 7 },
  ])
  await refetchDuePanel(page)

  const panel = page.getByTestId('due-panel')
  const future = panel.getByTestId('due-panel-item').filter({ hasText: 'Plan the offsite' })
  // Seeded: due today, no scheduled date, so the toggle never hides it.
  const unscheduled = panel.getByTestId('due-panel-item').filter({ hasText: 'Fix login bug' })
  await expect(future).toHaveCount(1)
  await expect(unscheduled).toHaveCount(1)

  const hideToggle = panel.getByRole('switch', { name: 'Hide future scheduled' })
  await hideToggle.click()
  await expect(hideToggle).toHaveAttribute('aria-checked', 'true')
  await expect(future).toHaveCount(0)
  await expect(unscheduled).toHaveCount(1)

  // The choice is a per-device preference: it survives leaving the journal.
  await refetchDuePanel(page)
  await expect(unscheduled).toHaveCount(1)
  await expect(future).toHaveCount(0)

  await hideToggle.click()
  await expect(hideToggle).toHaveAttribute('aria-checked', 'false')
  await expect(future).toHaveCount(1)
})

test('an overdue task reads "(3d overdue)" and a click opens it focused on its page @journal', async ({
  page,
}) => {
  const [id] = await seedSearchBlocks(page, [{ content: 'Renew passport', todo: 'TODO', due: -3 }])
  await refetchDuePanel(page)

  const row = page
    .getByTestId('due-panel')
    .locator('[data-slot="alert-list-row"]')
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
