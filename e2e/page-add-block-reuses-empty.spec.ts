import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * "Add block" on a page whose last block is already empty focuses that block
 * instead of minting a second one.
 *
 * A fresh page is seeded with one empty block (BlockTree's
 * `autoCreateFirstBlock`). Once the caret has left it, the blur cleanup keeps
 * it, because it is the page's only block; a second empty block from "Add
 * block" then stranded it above the one the user types into, and no later
 * focus change ever revisits it.
 */
test('Add block focuses the empty seed block of a fresh page', async ({ page }) => {
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  await page.getByPlaceholder('New page name...').fill('Seeded Page')
  await page
    .getByTestId('view-header-outlet')
    .getByRole('button', { name: /New Page/i })
    .click()

  const rows = page.locator('[data-testid="sortable-block"]')
  const editor = page.locator('[data-testid="block-editor"]')
  await expect(rows).toHaveCount(1)
  await expect(editor).toBeVisible()
  const seedId = await editor.getAttribute('data-block-id')
  expect(seedId).not.toBeNull()

  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)

  await page.getByRole('button', { name: 'Add block', exact: true }).click()
  await expect(editor).toHaveAttribute('data-block-id', seedId as string)
  await expect(rows).toHaveCount(1)
})
