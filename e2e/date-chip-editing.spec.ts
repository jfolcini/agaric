import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeDialog,
  activePopover,
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  reopenPage,
  settleBackend,
  test,
  waitForBoot,
} from './helpers'

/**
 * Editing a block's dates through the two date pickers (#5735):
 *
 *   - The Agenda due-date chip opens `DateChipEditor` (`BlockListItem.tsx`):
 *     a natural-language input parsed by `parseDate` (`src/lib/parse-date.ts`),
 *     Enter applies the parsed date, Escape closes the popover unchanged.
 *   - The journal Due panel's task rows carry the same chip (#7040): a date
 *     set on an Overdue row, due or scheduled, moves the task to the Today
 *     tab (#7155 R7).
 *   - The toolbar Date menu's "Set scheduled date" opens `BlockDatePicker`; a calendar
 *     day becomes the block's scheduled date.
 *
 * Both persist through `set_due_date` / `set_scheduled_date`, so each test
 * reads the chip, then leaves the view and comes back (the remount re-queries)
 * and reads it again. The mock shows a failure of either path, so the spec
 * lives in `e2e/`.
 *
 * The clock is pinned to Wednesday 2026-03-11 so every parsed date is fixed:
 * `+3d` is Mar 14, `next monday` Mar 16, `Apr 15` this year's Apr 15. The
 * clock is the browser's only, so each Agenda and Due panel test dates the
 * tasks it edits itself: "Submit report" (BLOCK_OVERDUE_1) due yesterday,
 * Mar 10.
 */

const PINNED_NOW = new Date('2026-03-11T12:00:00')

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: PINNED_NOW })
  await waitForBoot(page)
})

async function openAgenda(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await page.getByRole('tab', { name: 'Agenda view' }).click()
  await expect(page.getByTestId('agenda-view')).toBeVisible()
}

function submitReportChip(page: Page): Locator {
  return page
    .getByTestId('agenda-results-item')
    .filter({ hasText: 'Submit report' })
    .getByRole('button', { name: /^Due / })
}

/** Open the chip's editor and type `input`, waiting for the parse preview. */
async function typeIntoChipEditor(page: Page, input: string, parsed: string): Promise<Locator> {
  await submitReportChip(page).click()
  const popover = activePopover(page)
  const field = popover.getByRole('textbox', { name: 'Type a date' })
  await expect(field).toBeFocused()
  await field.fill(input)
  // Enter applies only once the debounced parse has produced a preview.
  await expect(popover.locator('strong')).toHaveText(parsed)
  return popover
}

async function leaveAndReturnToAgenda(page: Page): Promise<void> {
  await navigateToView(page, 'Tags')
  await expect(page.getByTestId('header-label')).toContainText('Tags')
  await openAgenda(page)
}

test.describe('Agenda due-date chip editor @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await ipc(page, 'set_property', {
      blockId: SEED_IDS.BLOCK_OVERDUE_1,
      key: 'due_date',
      value: { value_date: '2026-03-10' },
    })
  })

  for (const { input, parsed, chip } of [
    { input: '+3d', parsed: '2026-03-14', chip: 'Mar 14' },
    { input: 'next monday', parsed: '2026-03-16', chip: 'Mar 16' },
    { input: 'Apr 15', parsed: '2026-04-15', chip: 'Apr 15' },
  ]) {
    test(`"${input}" + Enter moves the due date and it persists`, async ({ page }) => {
      await openAgenda(page)
      await expect(submitReportChip(page)).toHaveText('Mar 10')

      const popover = await typeIntoChipEditor(page, input, parsed)
      await page.keyboard.press('Enter')
      await expect(popover).toBeHidden()
      await expect(submitReportChip(page)).toHaveText(chip)

      await leaveAndReturnToAgenda(page)
      await expect(submitReportChip(page)).toHaveText(chip)
    })
  }

  test('Escape closes the editor without changing the due date', async ({ page }) => {
    await openAgenda(page)
    await expect(submitReportChip(page)).toHaveText('Mar 10')

    const popover = await typeIntoChipEditor(page, '+3d', '2026-03-14')
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(submitReportChip(page)).toHaveText('Mar 10')

    await leaveAndReturnToAgenda(page)
    await expect(submitReportChip(page)).toHaveText('Mar 10')
  })
})

async function leaveAndReturnToJournal(page: Page): Promise<void> {
  await navigateToView(page, 'Tags')
  await expect(page.getByTestId('header-label')).toContainText('Tags')
  await navigateToView(page, 'Journal')
}

test.describe('Due panel row date chips @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    // Both overdue: one due yesterday, one scheduled two days ago with no due date.
    await ipc(page, 'set_due_date', { blockId: SEED_IDS.BLOCK_OVERDUE_1, date: '2026-03-10' })
    await ipc(page, 'set_due_date', { blockId: SEED_IDS.BLOCK_PROJ_4, date: null })
    await ipc(page, 'set_scheduled_date', { blockId: SEED_IDS.BLOCK_PROJ_4, date: '2026-03-09' })
    await settleBackend(page)
    // The panel mounted at boot: remount it so it reads those dates.
    await leaveAndReturnToJournal(page)
  })

  for (const { task, before, after } of [
    { task: 'Submit report', before: 'Due Mar 10', after: 'Due Mar 11' },
    { task: 'Design new dashboard', before: 'Scheduled Mar 9', after: 'Scheduled Mar 11' },
  ]) {
    test(`an Overdue row's "${before}" chip set to "today" moves the task to the Today tab and it persists`, async ({
      page,
    }) => {
      const panel = page.getByTestId('due-panel')
      const row = panel.getByTestId('due-panel-item').filter({ hasText: task })
      const showTab = async (name: string) => {
        await panel.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
        await expect(panel.getByRole('tab', { name: new RegExp(`^${name}`) })).toHaveAttribute(
          'aria-selected',
          'true',
        )
      }

      await showTab('Overdue')
      await row.getByRole('button', { name: before, exact: true }).click()
      const popover = activePopover(page)
      const field = popover.getByRole('textbox', { name: 'Type a date' })
      await expect(field).toBeFocused()
      await field.fill('today')
      await expect(popover.locator('strong')).toHaveText('2026-03-11')
      await page.keyboard.press('Enter')
      await expect(popover).toBeHidden()
      await expect(row).toHaveCount(0)

      for (const pass of ['now', 'after a remount']) {
        if (pass !== 'now') await leaveAndReturnToJournal(page)
        await showTab('Today')
        await expect(row.getByRole('button', { name: after, exact: true })).toBeVisible()
        await showTab('Overdue')
        await expect(row).toHaveCount(0)
      }
    })
  }
})

test('toolbar Set scheduled date: the picked day becomes a scheduled chip that persists @editor @journal', async ({
  page,
}) => {
  await openPage(page, 'Getting Started')
  await focusBlockById(page, SEED_IDS.BLOCK_GS_1)
  await page.getByRole('button', { name: 'Date', exact: true }).click()
  await page
    .getByTestId('toolbar-date-menu')
    .getByRole('button', { name: 'Set scheduled date' })
    .click()

  const picker = activeDialog(page)
  await expect(picker).toHaveAttribute('data-testid', 'date-picker-popup')
  await picker.locator('[role="gridcell"][data-day="2026-03-20"]').getByRole('button').click()
  await expect(picker).toBeHidden()

  const chip = page.getByRole('button', { name: 'Scheduled Mar 20', exact: true })
  await expect(chip).toBeVisible()

  await reopenPage(page, 'Getting Started')
  await expect(chip).toBeVisible()
})
