import { activeAlertDialog, expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * #5358 — the day's Page actions → Delete page soft-deleted today's page and its
 * blocks, but the day kept rendering them until a reload. Today is the seed's
 * daily page, which holds "Buy groceries".
 */
test('Delete page empties today at once, and the blocks stay gone @journal @pages', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Journal')
  const deleted = page.locator('[data-testid="block-static"]', { hasText: 'Buy groceries' })
  await expect(deleted).toBeVisible()

  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete page', exact: true }).click()
  await activeAlertDialog(page).getByRole('button', { name: 'Delete page', exact: true }).click()

  // No reload and no navigation: the empty state replaces the deleted blocks.
  await expect(page.getByRole('heading', { name: /^No blocks for/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add your first block' })).toBeVisible()
  await expect(deleted).toHaveCount(0)

  // Arriving back on today may make a fresh page, never the deleted one.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await expect(page.getByRole('button', { name: /^Add (your first )?block$/ })).toBeVisible()
  await expect(deleted).toHaveCount(0)
})
