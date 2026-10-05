import { activeAlertDialog, expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * E2E — following a recents entry to a page that was deleted from the Pages
 * view (#5243).
 *
 * Deletes leave recents and tab stacks alone and heal lazily when a stale
 * entry is followed. The load of a trashed page used to succeed with no
 * blocks, so the editor opened it blank and seeded a first block under the
 * deleted page. It is now refused, and the heal drops the entry under a trash
 * notice and pops back to the page underneath.
 */

test.describe('a trashed page in the recents (#5243)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('following it shows the trash notice and drops it from the recents', async ({ page }) => {
    // Stack = [Getting Started, Quick Notes]; both are in the recents.
    await openPage(page, 'Getting Started')
    await openPage(page, 'Quick Notes')

    await navigateToView(page, 'Pages')
    const grid = page.getByRole('grid')
    await grid
      .locator('[data-page-item]:has-text("Getting Started")')
      .getByRole('button', { name: 'Delete page' })
      .click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(grid.getByText('Getting Started', { exact: true })).toHaveCount(0)

    const recents = page.getByTestId('quick-access-bar')
    await recents.getByRole('button', { name: 'Getting Started', exact: true }).click()

    await expect(page.getByText('This page is in the trash', { exact: true })).toBeVisible()
    // A single snapshot, not `.not.toBeVisible()`: that matcher polls until a
    // transient toast auto-dismisses and passes whether or not it ever showed.
    expect(await page.getByText('Failed to create first block', { exact: true }).isVisible()).toBe(
      false,
    )
    // The heal popped the trashed page off the stack, back onto Quick Notes.
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(recents.getByRole('button', { name: 'Getting Started', exact: true })).toHaveCount(
      0,
    )
  })
})
