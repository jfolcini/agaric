import type { Page } from '@playwright/test'

import {
  blurEditors,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * Editor keyboard chords (#5733): the mark chords, Ctrl+Backspace on an empty
 * block, and Ctrl+Shift+V. Each is pressed as a real key chord and checked
 * after navigating away and back, so a chord the browser or another handler
 * takes first reads red here, which no unit test of the handler can show.
 */

const PAGE = 'Getting Started'
// SEED_IDS.BLOCK_GS_1 / BLOCK_GS_3 in src/lib/tauri-mock/seed.ts.
const GS1 = '0000000000000000000BLOCK01'
const GS3 = '0000000000000000000BLOCK03'

function staticBlock(page: Page, blockId: string) {
  return page.locator(`[data-testid="block-static"][data-block-id="${blockId}"]`)
}

function editorOf(page: Page, blockId: string) {
  return page.locator(
    `[data-testid="block-editor"][data-block-id="${blockId}"] [contenteditable="true"]`,
  )
}

test.describe('Editor keyboard chords (#5733) @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('Ctrl+Shift+S, Ctrl+Shift+H and Ctrl+U mark a word and the marks survive a reopen', async ({
    page,
  }) => {
    const editor = await focusBlockById(page, GS1)
    await replaceEditorText(page, 'one two three')
    await expect(editor).toHaveText('one two three')

    await selectEditorRange(page, 0, 3)
    await page.keyboard.press('Control+Shift+S')
    await selectEditorRange(page, 4, 7)
    await page.keyboard.press('Control+Shift+H')
    await selectEditorRange(page, 8, 13)
    // Chromium underlines on Ctrl+U natively when no handler takes it, so the
    // <u> checks pin the outcome and its persistence, not the app's binding.
    await page.keyboard.press('Control+u')
    await expect(editor.locator('s')).toHaveText('one')
    await expect(editor.locator('mark')).toHaveText('two')
    await expect(editor.locator('u')).toHaveText('three')

    await blurEditors(page)
    await reopenPage(page, PAGE)
    const block = staticBlock(page, GS1)
    await expect(block.locator('s')).toHaveText('one')
    await expect(block.locator('mark')).toHaveText('two')
    await expect(block.locator('u')).toHaveText('three')
  })

  test('Ctrl+Backspace deletes an empty block and focuses the one above', async ({ page }) => {
    const rows = page.locator('[data-testid="sortable-block"]')
    await expect(rows).toHaveCount(5)
    await focusBlockById(page, GS3)
    // Enter at the end of GS_3 makes an empty sibling below it.
    await saveBlock(page)
    await expect(rows).toHaveCount(6)
    const empty = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(empty).toBeFocused()
    await expect(empty).toHaveText('')

    await page.keyboard.press('Control+Backspace')

    await expect(rows).toHaveCount(5)
    await expect(editorOf(page, GS3)).toBeFocused()

    // The removal is optimistic; the reopen shows the backend deleted the row too.
    await blurEditors(page)
    await reopenPage(page, PAGE)
    await expect(rows).toHaveCount(5)
  })

  test('Ctrl+Shift+V pastes two Markdown lines into the block as typed', async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const rows = page.locator('[data-testid="sortable-block"]')
    await expect(rows).toHaveCount(5)
    const editor = await focusBlockById(page, GS1)
    await replaceEditorText(page, '')
    await expect(editor).toHaveText('')
    await page.evaluate(() => navigator.clipboard.writeText('# Plan\n- first step'))
    await expect(editor).toBeFocused()
    await page.keyboard.press('Control+Shift+V')
    await expect(editor).toHaveText('# Plan- first step')
    await expect(editor.locator('br')).toHaveCount(1)
    await expect(rows).toHaveCount(5)

    await blurEditors(page)
    await reopenPage(page, PAGE)
    await expect(rows).toHaveCount(5)
    await expect(staticBlock(page, GS1)).toHaveText('# Plan- first step')
    await expect(staticBlock(page, GS1).locator('br')).toHaveCount(1)
  })
})
