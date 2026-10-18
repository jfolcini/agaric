import type { Locator, Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * A due or scheduled chip on a block's metadata row opens the date picker for
 * THAT block, whether no block is being edited or another one is (#5736 found
 * it opening nothing, or writing the focused block). The picked date is read
 * back after leaving the page and returning, so a wrong target shows here.
 *
 * The clock is pinned so the chip labels are fixed. Seed
 * (`src/lib/tauri-mock/seed.ts`, `SEED_IDS`): Quick Notes has no dated blocks.
 */

const PINNED_NOW = new Date('2026-03-11T12:00:00')
const QUICK_NOTES = '00000000000000000000PAGE02'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: PINNED_NOW })
  await waitForBoot(page)
})

function row(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

async function pickMarch25(page: Page): Promise<void> {
  const picker = activeDialog(page)
  await expect(picker).toHaveAttribute('data-testid', 'date-picker-popup')
  await picker.locator('[role="gridcell"][data-day="2026-03-25"]').getByRole('button').click()
  await expect(picker).toBeHidden()
}

for (const { kind, label } of [
  { kind: 'due', label: 'Due' },
  { kind: 'scheduled', label: 'Scheduled' },
] as const) {
  test(`the ${kind} chip sets its own block's date while no block is being edited @editor @journal`, async ({
    page,
  }) => {
    const [chipId] = await seedSearchBlocks(page, [
      { content: 'Chip block', parentId: QUICK_NOTES, [kind]: '2026-03-20' },
    ])
    if (chipId === undefined) throw new Error('the seeded block has no id')

    await openPage(page, 'Quick Notes')
    await row(page, chipId)
      .getByRole('button', { name: `${label} Mar 20`, exact: true })
      .click()
    await pickMarch25(page)

    await reopenPage(page, 'Quick Notes')
    await expect(
      row(page, chipId).getByRole('button', { name: `${label} Mar 25`, exact: true }),
    ).toBeVisible()
  })

  test(`the ${kind} chip sets its own block's date, not the edited block's @editor @journal`, async ({
    page,
  }) => {
    const [chipId, editedId] = await seedSearchBlocks(page, [
      { content: 'Chip block', parentId: QUICK_NOTES, [kind]: '2026-03-20' },
      { content: 'Edited block', parentId: QUICK_NOTES },
    ])
    if (chipId === undefined || editedId === undefined) throw new Error('a seeded block has no id')

    await openPage(page, 'Quick Notes')
    await focusBlockById(page, editedId)
    await row(page, chipId)
      .getByRole('button', { name: `${label} Mar 20`, exact: true })
      .click()
    await pickMarch25(page)

    await reopenPage(page, 'Quick Notes')
    await expect(
      row(page, chipId).getByRole('button', { name: `${label} Mar 25`, exact: true }),
    ).toBeVisible()
    // The edited block had no metadata, so a date written to it would add a row.
    await expect(row(page, editedId).getByTestId('block-metadata-row')).toHaveCount(0)
  })
}
