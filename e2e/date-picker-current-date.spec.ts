import type { Locator, Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  openPage,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * The date picker a due or scheduled chip opens shows the date it edits and
 * can clear it (#6544): the title names the date, the block's day is the
 * selected one in its own month (not today's), and "Clear date" removes the
 * chip, which stays gone after leaving the page and coming back.
 *
 * The clock is pinned to March so a May date proves its month is the one in
 * view. Seed (`src/lib/tauri-mock/seed.ts`, `SEED_IDS`): Quick Notes has no
 * dated blocks.
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

for (const { kind, label, title } of [
  { kind: 'due', label: 'Due', title: 'Due date' },
  { kind: 'scheduled', label: 'Scheduled', title: 'Scheduled date' },
] as const) {
  test(`the ${kind} chip's picker shows its date and clears it, and the clear persists @editor @journal`, async ({
    page,
  }) => {
    const [blockId] = await seedSearchBlocks(page, [
      { content: 'Dated block', parentId: QUICK_NOTES, [kind]: '2026-05-20' },
    ])
    if (blockId === undefined) throw new Error('the seeded block has no id')

    await openPage(page, 'Quick Notes')
    await row(page, blockId)
      .getByRole('button', { name: `${label} May 20`, exact: true })
      .click()

    const picker = activeDialog(page)
    await expect(picker).toHaveAccessibleName(title)
    await expect(picker.locator('[role="gridcell"][data-selected]')).toHaveAttribute(
      'data-day',
      '2026-05-20',
    )

    await picker.getByRole('button', { name: 'Clear date' }).click()
    await expect(picker).toBeHidden()
    await expect(row(page, blockId).getByTestId('block-metadata-row')).toHaveCount(0)

    await reopenPage(page, 'Quick Notes')
    await expect(row(page, blockId)).toBeVisible()
    await expect(row(page, blockId).getByTestId('block-metadata-row')).toHaveCount(0)
  })
}
