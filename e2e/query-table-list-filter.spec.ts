/**
 * #6741, mock lane: a filter on a key that holds several values holds for a
 * block when it holds for one of its items, so a query table filtered to one
 * author lists exactly the blocks whose authors include them.
 *
 * Seed data: the Projects page's "Ship v2.0 release", "Fix login bug" and
 * "Update dependencies"; the `authors` key and its lists are set up through
 * the commands the drawer sends, which `property-list-drawer.spec.ts` drives.
 */

import type { Locator, Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  ipc,
  openPage,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const AUTHORS: ReadonlyArray<[blockId: string, authors: string[]]> = [
  ['0000000000000000000B10CK13', ['Ann', 'Bob']], // Ship v2.0 release
  ['0000000000000000000B10CK14', ['Bob']], // Fix login bug
  ['0000000000000000000B10CK15', ['Cy', 'Ann']], // Update dependencies
]

/** Give the Projects blocks their authors and put a table of Ann's blocks in Getting Started. */
async function tableOfAnnsBlocks(page: Page): Promise<Locator> {
  await waitForBoot(page)
  await ipc(page, 'create_property_def', {
    spaceId: 'SPACE_PERSONAL',
    key: 'authors',
    valueType: 'text',
    options: null,
    multiple: true,
  })
  for (const [blockId, authors] of AUTHORS) {
    await ipc(page, 'set_property', {
      blockId,
      key: 'authors',
      value: {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
        value_list: authors,
      },
    })
  }

  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('{{query prop:authors=Ann table:true}}', { delay: 20 })
  await saveBlock(page)
  return page
    .locator('[data-testid="sortable-block"]')
    .first()
    .locator('[data-testid="query-result"]')
}

test('a query table filtered to one author lists the blocks whose authors include them @search @editor', async ({
  page,
}) => {
  const table = await tableOfAnnsBlocks(page)
  const expectAnnsBlocks = async (): Promise<void> => {
    await expect(table.locator('tbody tr')).toHaveCount(2)
    const ship = table.getByRole('row').filter({ hasText: 'Ship v2.0 release' })
    const update = table.getByRole('row').filter({ hasText: 'Update dependencies' })
    await expect(ship.getByRole('button', { name: 'Edit authors: Ann, Bob' })).toBeVisible()
    await expect(update.getByRole('button', { name: 'Edit authors: Cy, Ann' })).toBeVisible()
  }
  await expectAnnsBlocks()

  await reopenPage(page, 'Getting Started')
  await expectAnnsBlocks()
})

test('a list cell adds an item with the list editor, and the list holds it after navigating away and back @search @editor', async ({
  page,
}) => {
  const table = await tableOfAnnsBlocks(page)
  const ship = table.getByRole('row').filter({ hasText: 'Ship v2.0 release' })

  await ship.getByRole('button', { name: 'Edit authors: Ann, Bob' }).click()
  const add = ship.getByRole('textbox', { name: 'Add an item to authors', exact: true })
  await expect(add).toBeFocused()
  await page.keyboard.type('Dee')
  await page.keyboard.press('Enter')
  await expect(ship.getByRole('button', { name: 'Remove Dee', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ship.getByRole('button', { name: 'Edit authors: Ann, Bob, Dee' })).toBeFocused()

  await reopenPage(page, 'Getting Started')
  await expect(ship.getByRole('button', { name: 'Edit authors: Ann, Bob, Dee' })).toBeVisible()
})
