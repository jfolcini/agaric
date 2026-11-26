import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  deleteBlockViaContextMenu,
  expect,
  ipc,
  navigateToView,
  openPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * The sidebar's Trash item carries a count badge (`useTrashCount` →
 * `count_trash`), and each trash row names the page its block came from
 * (`useTrashBreadcrumbs` → `batch_resolve`). Both are reads the mock answers
 * from its live block map, so a wrong count or a missing breadcrumb shows here.
 */

const GS_1 = '0000000000000000000B10CK01'
const QN_1 = '0000000000000000000B10CK08'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('Trash badge counts deleted blocks, rows name their page, restoring one lowers it @pages', async ({
  page,
}) => {
  await openPage(page, 'Getting Started')
  await deleteBlockViaContextMenu(page, page.locator(`[data-block-id="${GS_1}"]`).first())
  await expect(page.locator(`[data-block-id="${GS_1}"]`)).toHaveCount(0)
  await openPage(page, 'Quick Notes')
  await deleteBlockViaContextMenu(page, page.locator(`[data-block-id="${QN_1}"]`).first())
  await expect(page.locator(`[data-block-id="${QN_1}"]`)).toHaveCount(0)

  await navigateToView(page, 'Pages')
  const sidebar = page.locator('[data-slot="sidebar"]')
  const trashButton = sidebar.getByRole('button', { name: /^Trash/ })
  const badge = sidebar.locator('[data-sidebar="menu-badge"]')
  await expect(trashButton).toHaveAccessibleName('Trash, 2 items')
  await expect(badge).toHaveText('2')

  await trashButton.click()
  const rows = page.getByTestId('trash-item')
  await expect(rows).toHaveCount(2)
  const welcomeRow = rows.filter({ hasText: 'Welcome to Agaric' })
  const notesRow = rows.filter({ hasText: 'These notes complement' })
  await expect(welcomeRow.getByTestId('trash-item-breadcrumb')).toHaveText('from: Getting Started')
  await expect(notesRow.getByTestId('trash-item-breadcrumb')).toHaveText('from: Quick Notes')

  await notesRow.getByTestId('trash-restore-btn').click()
  await expect(rows).toHaveCount(1)

  await navigateToView(page, 'Pages')
  await expect(trashButton).toHaveAccessibleName('Trash, 1 item')
  await expect(badge).toHaveText('1')
})

const sidebarTrash = (page: Page) =>
  page.locator('[data-slot="sidebar"]').getByRole('button', { name: /^Trash/ })

/** Trash two seeded blocks and open Trash, its badge at 2. */
async function openTrashOfTwo(page: Page) {
  const ids = await seedSearchBlocks(page, [{ content: 'Trashed one' }, { content: 'Trashed two' }])
  for (const blockId of ids) await ipc(page, 'delete_block', { blockId })
  await navigateToView(page, 'Trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(2)
  await expect(sidebarTrash(page)).toHaveAccessibleName('Trash, 2 items')
}

/** The badge sits beside the Trash list, so it empties with the list, not on a later poll. */
async function expectNoBadge(page: Page) {
  await expect(sidebarTrash(page)).toHaveAccessibleName('Trash')
  await expect(page.locator('[data-slot="sidebar"] [data-sidebar="menu-badge"]')).toHaveCount(0)
}

test('restoring every item in Trash clears the sidebar badge at once @pages', async ({ page }) => {
  await openTrashOfTwo(page)
  const rows = page.getByTestId('trash-item')
  for (const left of [1, 0]) {
    await rows.first().getByTestId('trash-restore-btn').click()
    await expect(rows).toHaveCount(left)
  }
  await expectNoBadge(page)
})

test('emptying Trash clears the sidebar badge at once @pages', async ({ page }) => {
  await openTrashOfTwo(page)
  await page.getByTestId('trash-empty-trash-btn').click()
  await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()
  await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()
  await expectNoBadge(page)
})
