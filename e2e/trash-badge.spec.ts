import {
  deleteBlockViaContextMenu,
  expect,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * The Pages header's Trash button carries a count badge (`useTrashCount` →
 * `count_trash`), and each trash row names the page its block came from
 * (`useTrashBreadcrumbs` → `batch_resolve`). Both are reads the mock answers
 * from its live block map, so a wrong count or a missing breadcrumb shows here.
 */

const GS_1 = '0000000000000000000BLOCK01'
const QN_1 = '0000000000000000000BLOCK08'

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
  const trashButton = page.locator('.page-browser-header').getByRole('button', { name: /^Trash/ })
  await expect(trashButton).toHaveAccessibleName('Trash, 2 items')
  await expect(trashButton).toHaveText('2')

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
  await expect(trashButton).toHaveText('1')
})
