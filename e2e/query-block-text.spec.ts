import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  expect,
  focusBlock,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * A query block written in the search box's syntax (#6628): the text runs on
 * the query engine and stays the text as typed. A block that reads as the
 * older query text keeps its results.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): the tag `work` is attached to
 * BLOCK_PROJ_1 ("Ship v2.0 release", TODO), BLOCK_PROJ_2 ("Fix login bug",
 * DOING) and BLOCK_MTG_1 ("Weekly standup notes"); BLOCK_GS_4 writes it inline.
 */

const PAGE = 'Getting Started'

/** Make the first block of the page the query `text`; returns its result widget. */
async function writeQuery(page: Page, text: string): Promise<Locator> {
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(`{{query ${text}}}`, { delay: 20 })
  await saveBlock(page)
  return page
    .locator('[data-testid="sortable-block"]')
    .first()
    .locator('[data-testid="query-result"]')
}

test.describe('Query blocks in the search syntax @editor @search', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('runs, and holds the text as typed after navigating away and back', async ({ page }) => {
    const result = await writeQuery(page, 'tag:#work state:TODO')
    const items = result.getByTestId('query-result-item')
    await expect(result).toContainText('1 result')
    await expect(items).toHaveText([/Ship v2\.0 release/])

    await reopenPage(page, PAGE)
    await expect(result).toContainText('1 result')
    await expect(items).toHaveText([/Ship v2\.0 release/])
    // A click on a result row (not the header, which collapses) edits the block.
    await items.first().click()
    await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toHaveText(
      '{{query tag:#work state:TODO}}',
    )
  })

  test('a token a query block cannot run shows the error naming it', async ({ page }) => {
    const result = await writeQuery(page, 'state:TODO under:#work')
    const alert = result.getByRole('alert')
    await expect(alert).toContainText('under:#work')
    await expect(alert).toContainText('column 12')
    await expect(result.getByTestId('query-result-item')).toHaveCount(0)
  })

  test('the older text still matches tags by name prefix, inline ones too', async ({ page }) => {
    // `tag:work` without `#` reads as the older text: the three blocks the tag
    // is attached to and the one naming it inline. `tag:#work` is the search
    // syntax: the attached ones only.
    const legacy = await writeQuery(page, 'tag:work')
    await expect(legacy).toContainText('4 results')

    const search = await writeQuery(page, 'tag:#work')
    await expect(search).toContainText('3 results')
    await expect(search.getByTestId('query-result-item')).toHaveText([
      /Weekly standup notes/,
      /Fix login bug/,
      /Ship v2\.0 release/,
    ])
  })

  test('the builder saves an AND of filters as text, and reopens it', async ({ page }) => {
    await focusBlock(page)
    await typeSlashCommand(page, 'query')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Advanced', exact: true }).click()
    const root = dialog.getByRole('group', { name: 'Filter', exact: true })
    await root.getByRole('button', { name: 'Add filter', exact: true }).click()
    await activePopover(page)
      .getByRole('button', { name: /^State/ })
      .click()
    await activePopover(page).getByRole('checkbox', { name: 'TODO', exact: true }).click()
    await activePopover(page).getByRole('button', { name: 'Apply', exact: true }).click()
    await root.getByRole('button', { name: 'Add filter', exact: true }).click()
    await activePopover(page).getByRole('button', { name: /^Tag/ }).click()
    await activePopover(page).getByRole('button', { name: 'work', exact: true }).click()
    await expect(dialog.getByTestId('expression-preview')).toHaveText(
      'state:TODO #[000000000000000000000TAG01]',
    )
    await dialog.getByRole('button', { name: 'Insert Query' }).click()

    const result = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="query-result"]')
    const items = result.getByTestId('query-result-item')
    await expect(items).toHaveText([/Ship v2\.0 release/])

    await reopenPage(page, PAGE)
    await expect(items).toHaveText([/Ship v2\.0 release/])
    await result.getByRole('button', { name: 'Edit query' }).click()
    await expect(page.getByRole('dialog').getByTestId('advanced-filter-count')).toHaveText(
      '2 filters',
    )
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

    // The block holds the text, its tag a chip (which draws its own `#`).
    await items.first().click()
    await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toHaveText(
      '{{query state:TODO work}}',
    )
  })
})
