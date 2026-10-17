import {
  activeSheet,
  expect,
  focusBlockById,
  openPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * The `+N` badge on a block's property chip row opens THAT block's property
 * drawer, whether no block is being edited or another one is (#5736 found it
 * acting on the focused block). The drawer lists what the mock stores for the
 * block it was opened on, so a wrong target shows here.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`, `SEED_IDS`): Quick Notes has no
 * properties.
 */

const QUICK_NOTES = '00000000000000000000PAGE02'

const EIGHT_PROPS = {
  content: 'Eight properties',
  parentId: QUICK_NOTES,
  props: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5', k6: 'v6', k7: 'v7', k8: 'v8' },
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('+N opens the drawer for its block while no block is being edited', async ({ page }) => {
  const [blockId] = await seedSearchBlocks(page, [EIGHT_PROPS])
  if (blockId === undefined) throw new Error('the seeded block has no id')

  await openPage(page, 'Quick Notes')
  const row = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
  await row.getByRole('button', { name: 'Show all 8 properties (Ctrl+Shift+P)' }).click()

  // k8 is past the inline cap, so only the drawer shows it.
  await expect(activeSheet(page).getByRole('textbox', { name: 'k8 value' })).toHaveValue('v8')
})

test('+N opens the drawer for its block, not the one being edited', async ({ page }) => {
  const [blockId, otherId] = await seedSearchBlocks(page, [
    EIGHT_PROPS,
    { content: 'No properties', parentId: QUICK_NOTES },
  ])
  if (blockId === undefined || otherId === undefined) throw new Error('a seeded block has no id')

  await openPage(page, 'Quick Notes')
  await focusBlockById(page, otherId)
  const row = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
  await row.getByRole('button', { name: 'Show all 8 properties (Ctrl+Shift+P)' }).click()

  await expect(activeSheet(page).getByRole('textbox', { name: 'k8 value' })).toHaveValue('v8')
})
