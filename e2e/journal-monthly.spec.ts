import type { Page } from '@playwright/test'

import { expect, ipc, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * Monthly mode and the journal date picker: a day with a due and a scheduled
 * task shows one dot per source, an empty day shows none, and clicking a
 * dotted Monthly day opens Daily on that date with its journal page and its
 * tasks (#5735).
 *
 * In `e2e/` because the mock models every read behind the dots and the Daily
 * view. The seeded days are in the month after the pinned clock: the current
 * month's journal pages are cached at boot (`calendar-page-dates-cache.ts`)
 * until a TTL the pinned clock never reaches, and a page created over IPC,
 * unlike one created in the journal, is not merged into that cache.
 */

const NOW = new Date('2026-10-14T10:00:00')
const DOTTED_DAYS = ['2026-11-05', '2026-11-26']
const EMPTY_DAY = '2026-11-09'

async function seedDay(page: Page, day: string): Promise<void> {
  const journalId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: day,
    spaceId: 'SPACE_PERSONAL',
  })
  await seedSearchBlocks(page, [
    { content: `Note for ${day}`, parentId: journalId },
    { content: `Due on ${day}`, todo: 'TODO', due: day },
    { content: `Scheduled on ${day}`, todo: 'TODO', scheduled: day },
  ])
}

test('Monthly mode dots each source on a day, none on an empty day, and a click opens Daily @journal', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW)
  await waitForBoot(page)
  for (const day of DOTTED_DAYS) await seedDay(page, day)

  await page.getByRole('tab', { name: 'Monthly view' }).click()
  await page.getByRole('button', { name: 'Next month' }).click()
  await expect(page.getByTestId('date-display')).toHaveText('November 2026')
  const grid = page.getByRole('grid', { name: 'Monthly calendar' })
  const cell = (date: string) => grid.locator(`[role="gridcell"][data-date="${date}"]`)

  // The dots are aria-hidden spans whose colour token is the source type.
  for (const day of DOTTED_DAYS) {
    await expect(cell(day)).toHaveAccessibleName(/, 2 agenda items$/)
    await expect(cell(day).locator('span.bg-date-due-foreground')).toHaveCount(1)
    await expect(cell(day).locator('span.bg-date-scheduled-foreground')).toHaveCount(1)
  }
  await expect(cell(EMPTY_DAY)).toHaveAccessibleName('Monday, November 9, 2026')
  await expect(cell(EMPTY_DAY).locator('span[aria-hidden="true"]')).toHaveCount(0)

  await cell('2026-11-26').click()

  await expect(page.getByRole('tab', { name: 'Daily view' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByTestId('date-display')).toHaveText('Thu, Nov 26, 2026')
  await expect(page.getByText('Note for 2026-11-26', { exact: true })).toBeVisible()
  const duePanel = page.getByTestId('due-panel')
  await expect(duePanel.getByText('Due on 2026-11-26')).toBeVisible()
  await expect(duePanel.getByText('Scheduled on 2026-11-26')).toBeVisible()
})

test('the date picker dots each source on a day and none on an empty day @journal', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW)
  await waitForBoot(page)
  for (const day of DOTTED_DAYS) await seedDay(page, day)

  await page.getByRole('button', { name: /Open calendar picker$/ }).click()
  const picker = page.getByRole('dialog', { name: 'Date picker' })
  await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  const cell = (date: string) => picker.locator(`[role="gridcell"][data-day="${date}"]`)

  // Page, due and scheduled each have their own colour token.
  for (const day of DOTTED_DAYS) {
    const dots = cell(day).getByTestId('calendar-dots')
    await expect(dots.locator('span.bg-primary')).toHaveCount(1)
    await expect(dots.locator('span.bg-date-due-foreground')).toHaveCount(1)
    await expect(dots.locator('span.bg-date-scheduled-foreground')).toHaveCount(1)
  }
  await expect(picker).toHaveAttribute('aria-busy', 'false')
  await expect(cell(EMPTY_DAY)).toBeVisible()
  await expect(cell(EMPTY_DAY).getByTestId('calendar-dots')).toHaveCount(0)
})
