import type { Locator, Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5737: the page header's Page actions menu (`PageHeaderMenu`). Undo and Redo
 * there drive the page-level undo store, which Ctrl+Z specs reach only through
 * the keyboard; Insert emoji opens the picker that writes into the page title
 * (`handleTitleEmojiSelect` in `PageHeader`). Both run against the mock and are
 * read back after reopening the page.
 */

// SEED_IDS.BLOCK_GS_1 / BLOCK_GS_3 and their seed text (src/lib/tauri-mock/seed.ts).
const GS_1 = '0000000000000000000BLOCK01'
const GS_3 = '0000000000000000000BLOCK03'
const GS_1_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'
const GS_3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'

function staticBlock(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${blockId}"]`)
}

async function pageAction(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function editBlock(page: Page, blockId: string, text: string): Promise<void> {
  await focusBlockById(page, blockId)
  await replaceEditorText(page, text)
  await saveBlock(page, 'Escape')
  await expect(staticBlock(page, blockId)).toHaveText(text)
}

test.describe('Page actions menu @pages', () => {
  test('Undo twice then Redo walks two block edits back and forward', async ({ page }) => {
    // Edits less than `UNDO_GROUP_WINDOW_MS` apart join one undo entry; the
    // fast-forward below keeps the two edits two entries.
    await page.clock.install()
    await waitForBoot(page)
    await openPage(page, 'Getting Started')

    await editBlock(page, GS_1, 'First edit')
    await page.clock.fastForward(1000)
    await editBlock(page, GS_3, 'Second edit')

    await pageAction(page, /^Undo last page action/)
    await expect(staticBlock(page, GS_3)).toHaveText(GS_3_TEXT)
    await expect(staticBlock(page, GS_1)).toHaveText('First edit')

    await pageAction(page, /^Undo last page action/)
    await expect(staticBlock(page, GS_1)).toHaveText(GS_1_TEXT)
    await expect(staticBlock(page, GS_3)).toHaveText(GS_3_TEXT)

    await pageAction(page, /^Redo last page action/)
    await expect(staticBlock(page, GS_1)).toHaveText('First edit')
    await expect(staticBlock(page, GS_3)).toHaveText(GS_3_TEXT)

    await reopenPage(page, 'Getting Started')
    await expect(staticBlock(page, GS_1)).toHaveText('First edit')
    await expect(staticBlock(page, GS_3)).toHaveText(GS_3_TEXT)
  })

  test('Insert emoji appends the picked glyph to the page title', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Quick Notes')
    const title = page.getByLabel('Page title', { exact: true })

    await pageAction(page, 'Insert emoji')
    const picker = activeDialog(page)
    await picker.getByRole('searchbox', { name: 'Search emoji', exact: true }).fill('rocket')
    await picker.getByRole('gridcell', { name: 'rocket', exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(title).toHaveText('Quick Notes🚀')

    await reopenPage(page, 'Quick Notes🚀')
    await expect(title).toHaveText('Quick Notes🚀')
  })
})
