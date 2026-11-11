import {
  deleteBlockViaContextMenu,
  expect,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

// The mock stamped `deleted_at` as an ISO string with a sequence suffix, which
// no date parser reads, so every trashed row said "Deleted: NaNd ago". The
// backend stamps an epoch-ms number.
test('a trashed row says when it was deleted @pages', async ({ page }) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await deleteBlockViaContextMenu(page, page.locator('[data-testid="sortable-block"]').first())
  await navigateToView(page, 'Trash')
  const row = page.locator('[data-testid="trash-item"]')
  await expect(row).toHaveCount(1)
  await expect(row.locator('.trash-item-date')).toHaveText('Deleted: just now')
})
