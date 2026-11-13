import { pageRow } from './domain'
import { expect, ipc, navigateToView, test, waitForBoot } from './helpers'

/**
 * The Pages list keys its virtual rows by what they show, not by position. A
 * bookmark toggle re-sorts the list; keyed by position, every row the move
 * shifted was reused for the page that slid into its slot, and handed that
 * page the focused star and a namespace's collapsed state.
 */
test('a bookmark re-sort keeps focus and a collapsed namespace with their pages @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  for (const content of ['Alpha/one', 'Beta/two']) {
    await ipc(page, 'create_page_in_space', { parentId: null, content, spaceId: 'SPACE_PERSONAL' })
  }
  await navigateToView(page, 'Pages')
  const grid = page.getByRole('grid')
  const starredSection = grid.locator('[data-page-section="starred"]')
  await grid.getByRole('button', { name: 'Toggle Beta namespace' }).click()
  await expect(grid.getByRole('button', { name: 'two', exact: true })).toHaveCount(0)
  await expect(grid.getByRole('button', { name: 'one', exact: true })).toBeVisible()

  // Meetings sorts below both namespaces, so its move to Bookmarks shifts them.
  await pageRow(page, 'Meetings').getByRole('button', { name: 'Bookmark page' }).click()
  await expect(starredSection).toBeVisible()
  await expect(
    pageRow(page, 'Meetings').getByRole('button', { name: 'Remove page from bookmarks' }),
  ).toBeFocused()
  await expect(grid.getByRole('button', { name: 'two', exact: true })).toHaveCount(0)
  await expect(grid.getByRole('button', { name: 'one', exact: true })).toBeVisible()

  await pageRow(page, 'Meetings')
    .getByRole('button', { name: 'Remove page from bookmarks' })
    .click()
  await expect(starredSection).toHaveCount(0)
  await expect(
    pageRow(page, 'Meetings').getByRole('button', { name: 'Bookmark page' }),
  ).toBeFocused()
  await expect(grid.getByRole('button', { name: 'two', exact: true })).toHaveCount(0)
  await expect(grid.getByRole('button', { name: 'one', exact: true })).toBeVisible()
})
