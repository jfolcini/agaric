/**
 * Turn into by the Ctrl+Shift+T chord (`turnIntoBlock`, #5733): the chord opens
 * the Turn into picker on a focused block that already has text, with the caret
 * after a non-space character, and leaves that text exactly as it was whether a
 * type is picked or the picker is dismissed. The mock can show both failures (no
 * picker opening, a stray `/turn` left in the block), so the spec lives in `e2e/`.
 */
import {
  activeSuggestionList,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

// `SEED_IDS.BLOCK_GS_3` and its content in `src/lib/tauri-mock/seed.ts`.
const GS_3 = '0000000000000000000BLOCK03'
const GS_3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'

test.describe('Turn into by the Ctrl+Shift+T chord @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  async function openPickerAtEnd(page: import('@playwright/test').Page) {
    const editor = await focusBlockById(page, GS_3)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText(GS_3_TEXT)
    await selectEditorRange(page, GS_3_TEXT.length, GS_3_TEXT.length)
    await page.keyboard.press('Control+Shift+T')
    const list = activeSuggestionList(page)
    await expect(list).toBeVisible()
    return { editor, list }
  }

  const staticBlock = (page: import('@playwright/test').Page) =>
    page.locator(`[data-testid="block-static"][data-block-id="${GS_3}"]`)

  test('picking Quote turns a block with text into a quote and persists', async ({ page }) => {
    const { editor, list } = await openPickerAtEnd(page)
    await list.locator('[data-testid="suggestion-item"]', { hasText: 'Quote' }).first().click()

    await expect(editor.locator('blockquote')).toHaveText(GS_3_TEXT)

    await reopenPage(page, 'Getting Started')
    await expect(staticBlock(page).locator('blockquote')).toHaveText(GS_3_TEXT)
  })

  test('moving the caret into the first word closes the picker and keeps the word', async ({
    page,
  }) => {
    const { editor, list } = await openPickerAtEnd(page)
    // Three characters past the caret: inside `Create` had the trigger been glued to it.
    await selectEditorRange(page, 8, 8)

    await expect(list).toBeHidden()
    await expect(editor).toHaveText(GS_3_TEXT)

    await page.keyboard.press('Escape')
    await reopenPage(page, 'Getting Started')
    await expect(staticBlock(page)).toHaveText(GS_3_TEXT)
  })

  test('Escape closes the picker and leaves the text unchanged', async ({ page }) => {
    const { editor, list } = await openPickerAtEnd(page)
    await page.keyboard.press('Escape')

    await expect(list).toBeHidden()
    await expect(editor).toHaveText(GS_3_TEXT)

    await reopenPage(page, 'Getting Started')
    await expect(staticBlock(page)).toHaveText(GS_3_TEXT)
  })
})
