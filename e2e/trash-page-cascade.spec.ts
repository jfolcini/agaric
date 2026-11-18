import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { pageRow } from './domain'
import { activeAlertDialog, expect, ipc, navigateToView, test, waitForBoot } from './helpers'

/**
 * A deleted page and its tree in the Trash (#5737). Deleting a page soft-deletes its whole
 * subtree in one cohort (`delete_block`); Trash lists only the cohort's root, with a "+N blocks"
 * badge (`list_trash` + `trash_descendant_counts`); Restore brings the cohort back
 * (`restore_block`) and Purge erases it (`purge_block`). Each case re-reads the result after a
 * view change.
 */

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

/** A page titled `title` holding `chain`, each block the child of the one before it. */
async function seedChainPage(page: Page, title: string, chain: string[]): Promise<void> {
  let parentId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  for (const content of chain) {
    const block = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
    parentId = block.id
  }
}

/** Each of `chain` shown one level below the one before it, on the open page. */
async function expectChain(page: Page, chain: string[]): Promise<void> {
  for (const [i, content] of chain.entries()) {
    await expect(
      page.locator(`li[aria-level="${i + 1}"]`).getByText(content, { exact: true }),
    ).toBeVisible()
  }
}

/** Open the page titled `title` from its Pages row: the quick-access bar holds a second copy of its name. */
async function openFromPages(page: Page, title: string): Promise<void> {
  await navigateToView(page, 'Tags')
  await navigateToView(page, 'Pages')
  await pageRow(page, title).getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function trashRow(page: Page, title: string) {
  return page.getByTestId('trash-item').filter({ hasText: title })
}

const CHAIN = ['cascade one', 'cascade two', 'cascade six']

test.describe('Trash: a deleted page’s tree, restored or purged (#5737) @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('lists a page deleted from Pages once with its child count, and Restore brings its tree back', async ({
    page,
  }) => {
    await seedChainPage(page, 'Cascade page', CHAIN)
    await openFromPages(page, 'Cascade page')
    await expectChain(page, CHAIN)

    await navigateToView(page, 'Pages')
    await pageRow(page, 'Cascade page').getByRole('button', { name: 'Delete page' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(pageRow(page, 'Cascade page')).toHaveCount(0)

    await navigateToView(page, 'Trash')
    // One row for the cohort: none for any block of its tree.
    await expect(trashRow(page, 'Cascade page')).toHaveCount(1)
    await expect(page.getByTestId('trash-item').filter({ hasText: 'cascade' })).toHaveCount(1)
    await expect(trashRow(page, 'Cascade page').getByTestId('trash-descendant-badge')).toHaveText(
      '+3 blocks',
    )

    await trashRow(page, 'Cascade page').getByTestId('trash-restore-btn').click()
    await expect(trashRow(page, 'Cascade page')).toHaveCount(0)
    await openFromPages(page, 'Cascade page')
    await expectChain(page, CHAIN)
  })

  test('a page deleted from its kebab and purged stays out of Pages and Trash', async ({
    page,
  }) => {
    await seedChainPage(page, 'Purged page', CHAIN)
    await openFromPages(page, 'Purged page')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete page', exact: true }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete page', exact: true }).click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await expect(pageRow(page, 'Purged page')).toHaveCount(0)

    await navigateToView(page, 'Trash')
    await trashRow(page, 'Purged page').getByTestId('trash-purge-btn').click()
    await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()
    await expect(trashRow(page, 'Purged page')).toHaveCount(0)

    // TrashView drops the row before its reload lands; only a fresh read shows the purge.
    await navigateToView(page, 'Tags')
    await navigateToView(page, 'Trash')
    await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()
    await navigateToView(page, 'Pages')
    await expect(pageRow(page, 'Getting Started')).toBeVisible()
    await expect(pageRow(page, 'Purged page')).toHaveCount(0)
  })
})
