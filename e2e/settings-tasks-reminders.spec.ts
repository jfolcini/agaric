import type { Page } from '@playwright/test'

import {
  expect,
  navigateToView,
  openSettingsTab,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * Settings › Tasks & reminders › Deadline warning (#5741): the number of days
 * set there is the window the Due panel's Upcoming section lists on today.
 * The backend answers the panel's `query_by_property` date range, so a window
 * that ignores the setting shows here.
 */

// Seeded on Projects relative to today: due tomorrow and in a week.
const SEED_TOMORROW = 'Ship v2.0 release'
const SEED_NEXT_WEEK = 'Design new dashboard'
const IN_TWO_DAYS = 'Task due in two days'
const IN_FIVE_DAYS = 'Task due in five days'

async function setDeadlineWarning(page: Page, days: number): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Tasks & reminders')
  const input = page.getByRole('spinbutton', { name: 'Deadline warning' })
  await input.fill(String(days))
  await expect(input).toHaveValue(String(days))
}

/** The rows of today's Upcoming section, opened fresh from the Journal. */
async function upcomingRows(page: Page) {
  await navigateToView(page, 'Journal')
  const section = page
    .locator('#journal-due-panel')
    .getByRole('heading', { name: /^Upcoming/ })
    .locator('xpath=..')
  return section.locator('[data-slot="alert-list-row"]')
}

test.describe('Settings › Tasks & reminders: deadline warning @settings @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedSearchBlocks(page, [
      { content: IN_TWO_DAYS, todo: 'TODO', due: 2 },
      { content: IN_FIVE_DAYS, todo: 'TODO', due: 5 },
    ])
  })

  test('the warning days set the Due panel Upcoming window', async ({ page }) => {
    await setDeadlineWarning(page, 3)
    await expect(await upcomingRows(page)).toHaveText([
      new RegExp(SEED_TOMORROW),
      new RegExp(IN_TWO_DAYS),
    ])

    await setDeadlineWarning(page, 7)
    await expect(await upcomingRows(page)).toHaveText([
      new RegExp(SEED_TOMORROW),
      new RegExp(IN_TWO_DAYS),
      new RegExp(IN_FIVE_DAYS),
      new RegExp(SEED_NEXT_WEEK),
    ])
  })

  // A form problem is said next to its field, not in a toast (#6870).
  test('a value past the limit is kept to it, and the field says so until the next edit', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Tasks & reminders')
    const input = page.getByRole('spinbutton', { name: 'Deadline warning' })

    await input.fill('200')
    await expect(input).toHaveValue('90')
    await expect(page.getByText('Value clamped to 0–90', { exact: true })).toBeVisible()
    // Playwright's description computation skips `<output>` text, which
    // Chromium's accessibility tree includes, so the wiring is asserted.
    await expect(input).toHaveAttribute('aria-describedby', /deadline-warning-days-clamped/)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

    await input.fill('5')
    await expect(input).toHaveValue('5')
    await expect(page.getByText('Value clamped to 0–90', { exact: true })).toHaveCount(0)
  })
})
