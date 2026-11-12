import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  expect,
  focusBlock,
  openPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/** Back to a page visited before, which `openPage`'s exact-text click finds twice. */
async function revisitPage(page: Page, title: string) {
  await page.getByTestId('quick-access-bar').getByRole('button', { name: title }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

async function editFirstBlock(page: Page, text: string) {
  await focusBlock(page, 0)
  await replaceEditorText(page, text)
  await saveBlock(page, 'Escape')
}

test.describe('History scoped to one page (#6535) @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page menu opens that page history, and restoring it leaves other pages alone', async ({
    page,
  }) => {
    // B's edit lands between A's two, so an unscoped restore to A's first
    // edit would revert it too.
    await openPage(page, 'Getting Started')
    await editFirstBlock(page, 'Alpha first')
    await openPage(page, 'Quick Notes')
    await editFirstBlock(page, 'Bravo edit')
    await revisitPage(page, 'Getting Started')
    await editFirstBlock(page, 'Alpha second')

    await page.getByRole('button', { name: 'Page actions' }).click()
    await page.getByRole('menuitem', { name: 'Page history' }).click()

    await expect(page.getByTestId('header-label')).toHaveText('History')
    await expect(page.getByText('Changes to Getting Started')).toBeVisible()
    const rows = page.locator('[data-history-item]')
    // A's two edits and the seed's dated title stamp on A's page block.
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: 'Alpha second' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Bravo edit' })).toHaveCount(0)

    await rows.filter({ hasText: 'Alpha first' }).locator('.restore-to-here-btn').click()
    await activeAlertDialog(page).getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(page.getByText('1 operation reverted successfully')).toBeVisible()

    // The way back to the whole vault's history.
    await page.getByRole('button', { name: 'Show all pages' }).click()
    await expect(page.getByText('Changes to Getting Started')).toHaveCount(0)
    await expect(rows.filter({ hasText: 'Bravo edit' })).toHaveCount(1)

    const firstBlock = page.locator('[data-testid="block-static"]').first()
    await revisitPage(page, 'Quick Notes')
    await expect(firstBlock).toHaveText('Bravo edit')
    await revisitPage(page, 'Getting Started')
    await expect(firstBlock).toHaveText('Alpha first')
  })
})
