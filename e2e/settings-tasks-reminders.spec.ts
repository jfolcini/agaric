import type { Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * Settings › Tasks & reminders › Deadline warning (#5741): the number of days
 * set there is the window the Due panel's Upcoming section lists on today.
 * The mock answers the panel's `query_by_property` date range, so a window
 * that ignores the setting shows here.
 */

// `SEED_IDS.PAGE_PROJECTS` in src/lib/tauri-mock/seed.ts.
const PAGE_PROJECTS = '00000000000000000000PAGE04'
// Seeded on Projects relative to today: due tomorrow and in a week.
const SEED_TOMORROW = 'Ship v2.0 release'
const SEED_NEXT_WEEK = 'Design new dashboard'
const IN_TWO_DAYS = 'Task due in two days'
const IN_FIVE_DAYS = 'Task due in five days'

/** Create a TODO on Projects due `days` after today. */
async function seedTask(page: Page, content: string, days: number): Promise<void> {
  await page.evaluate(
    async ({ text, offset, parentId }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      const due = new Date()
      due.setDate(due.getDate() + offset)
      const pad = (n: number) => String(n).padStart(2, '0')
      const date = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`
      const block = (await invoke('create_block', {
        blockType: 'content',
        content: text,
        parentId,
        index: null,
        scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
        blockId: null,
      })) as { id: string }
      await invoke('set_todo_state', { blockId: block.id, state: 'TODO' })
      await invoke('set_due_date', { blockId: block.id, date })
    },
    { text: content, offset: days, parentId: PAGE_PROJECTS },
  )
}

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

test.describe('Settings › Tasks & reminders: deadline warning', () => {
  test.beforeEach(async ({ page }) => {
    // A Wednesday morning, so no window crosses midnight mid-test.
    await page.clock.install({ time: new Date('2026-03-11T09:00:00') })
    await waitForBoot(page)
    await seedTask(page, IN_TWO_DAYS, 2)
    await seedTask(page, IN_FIVE_DAYS, 5)
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
})
