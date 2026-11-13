import type { Locator, Page } from '@playwright/test'

import { expect, focusBlock, openPage, reopenPage, saveBlock, test, waitForBoot } from './helpers'

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
})
