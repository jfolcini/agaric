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
  test,
  waitForBoot,
} from './helpers'

/**
 * Editing a block's dates through the two date pickers (#5735):
 *
 *   - The Agenda due-date chip opens `DateChipEditor` (`BlockListItem.tsx`):
 *     a natural-language input parsed by `parseDate` (`src/lib/parse-date.ts`),
 *     Enter applies the parsed date, Escape closes the popover unchanged.
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
 * clock is the browser's only, so each Agenda test dates "Submit report"
 * (BLOCK_OVERDUE_1) itself: due yesterday, Mar 10.
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
    .getByRole('button', { name: 'Edit date' })
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
