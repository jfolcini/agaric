import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

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

// Seed id, see src/lib/tauri-mock/seed.ts SEED_IDS.PAGE_PROJECTS ("Projects").
const PAGE_PROJECTS = '00000000000000000000PAGE04'
const TODAY = new Date('2026-10-14T10:00:00')

function dateStr(daysFromToday: number): string {
  const d = new Date(TODAY)
  d.setDate(d.getDate() + daysFromToday)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Create a TODO under Projects with the given dates; returns its id. */
async function seedTask(
  page: Page,
  content: string,
  dates: { due: string; scheduled?: string },
): Promise<string> {
  const id = await page.evaluate(
    async ({ text, parentId, due, scheduled }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      const block = (await invoke('create_block', {
        blockType: 'content',
        content: text,
        parentId,
        index: null,
        scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
        blockId: null,
      })) as { id: string }
      await invoke('set_todo_state', { blockId: block.id, state: 'TODO' })
      await invoke('set_due_date', { blockId: block.id, date: due })
      if (scheduled) await invoke('set_scheduled_date', { blockId: block.id, date: scheduled })
      return block.id
    },
    { text: content, parentId: PAGE_PROJECTS, due: dates.due, scheduled: dates.scheduled ?? null },
  )
  // Leave and re-enter the journal so the Due panel refetches.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  return id
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: TODAY })
  await waitForBoot(page)
})

test('hide-before-scheduled hides a task scheduled next week and shows it again', async ({
  page,
}) => {
  await seedTask(page, 'Plan the offsite', { due: dateStr(0), scheduled: dateStr(7) })

  const panel = page.getByTestId('due-panel')
  const future = panel.getByTestId('due-panel-item').filter({ hasText: 'Plan the offsite' })
  // Seeded: due today, no scheduled date, so the toggle never hides it.
  const unscheduled = panel.getByTestId('due-panel-item').filter({ hasText: 'Fix login bug' })
  await expect(future).toHaveCount(1)
  await expect(unscheduled).toHaveCount(1)

  await panel.getByRole('button', { name: 'Scheduled: show all' }).click()
  const hideToggle = panel.getByRole('button', { name: 'Scheduled: hide future' })
  await expect(hideToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(future).toHaveCount(0)
  await expect(unscheduled).toHaveCount(1)

  // The choice is a per-device preference: it survives leaving the journal.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await expect(unscheduled).toHaveCount(1)
  await expect(future).toHaveCount(0)

  await hideToggle.click()
  await expect(panel.getByRole('button', { name: 'Scheduled: show all' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(future).toHaveCount(1)
})

test('an overdue task reads "(3d overdue)" and a click opens it focused on its page', async ({
  page,
}) => {
  const id = await seedTask(page, 'Renew passport', { due: dateStr(-3) })

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
