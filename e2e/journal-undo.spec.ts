import type { Locator, Page } from '@playwright/test'

import {
  blurEditors,
  expect,
  focusBlockById,
  getInvokeCalls,
  installIpcRecorder,
  ipc,
  navigateToView,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6541 — Ctrl+Z / Ctrl+Y in the journal act on the page of the day the user
 * worked in: the focused block's day, or with none focused the day last worked
 * in. A press never reaches another day's page.
 *
 * Seed: today's journal page, PAGE03, holds BLOCK06 (src/lib/tauri-mock/seed.ts).
 */

const TODAY_PAGE = '00000000000000000000PAGE03'
const TODAY_BLOCK = '0000000000000000000BLOCK06'
const TODAY_TEXT = 'Morning standup notes go here'
const EDITED = 'Edited in the journal'
const OTHER_TEXT = 'Another day’s note'

const row = (page: Page, blockId: string): Locator =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
const stored = async (page: Page, blockId: string): Promise<string> =>
  (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
const editor = (page: Page): Locator =>
  page.locator('[data-testid="block-editor"] [contenteditable="true"]')

/** Edit today's block and leave it with Escape, as a user finishing a line does. */
async function editTodayBlock(page: Page): Promise<void> {
  await focusBlockById(page, TODAY_BLOCK)
  await replaceEditorText(page, EDITED)
  await saveBlock(page, 'Escape')
  await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(EDITED)
}

test.describe('Journal day view: undo and redo act on the day @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Daily view' }).click()
    await expect(row(page, TODAY_BLOCK)).toBeVisible()
  })

  test('Ctrl+Z after Escape undoes the edit, Ctrl+Y redoes it, and the undo persists', async ({
    page,
  }) => {
    await editTodayBlock(page)

    await page.keyboard.press('Control+z')
    await expect(row(page, TODAY_BLOCK)).toHaveText(TODAY_TEXT)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(TODAY_TEXT)

    await page.keyboard.press('Control+y')
    await expect(row(page, TODAY_BLOCK)).toHaveText(EDITED)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(EDITED)

    await page.keyboard.press('Control+z')
    await expect(row(page, TODAY_BLOCK)).toHaveText(TODAY_TEXT)
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
    await expect(row(page, TODAY_BLOCK)).toHaveText(TODAY_TEXT)
  })

  test('Ctrl+Z in the block, back in it after Escape, undoes its edit in place', async ({
    page,
  }) => {
    await editTodayBlock(page)
    await focusBlockById(page, TODAY_BLOCK)

    await page.keyboard.press('Control+z')
    await expect(editor(page)).toHaveText(TODAY_TEXT)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(TODAY_TEXT)
    await expect(editor(page)).toBeFocused()

    await page.keyboard.press('Control+Shift+z')
    await expect(editor(page)).toHaveText(EDITED)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(EDITED)
  })
})

/**
 * The rule across days: a press acts on the page of the day last worked in,
 * and keeps to it; reaching an earlier day's edit takes working in that day.
 */
test.describe('Journal week view: undo keeps to the day last worked in @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    // Mount every day's tree at once instead of on scroll (DaySection).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()
  })

  test('Ctrl+Z and Ctrl+Y act on the later day’s edit, and a press past it stays on that day', async ({
    page,
  }) => {
    // The earlier edit: a block added to another day of the week.
    const otherDay = page.locator('section[id^="journal-2"]').filter({ hasText: 'No blocks for' })
    await otherDay.first().getByRole('button', { name: 'Add block' }).click()
    await expect(editor(page)).toBeVisible()
    await editor(page).pressSequentially(OTHER_TEXT)
    await expect(editor(page)).toHaveText(OTHER_TEXT)
    await blurEditors(page)
    const otherRow = page.locator('[data-testid="sortable-block"]').filter({ hasText: OTHER_TEXT })
    const otherBlock = (await otherRow.getAttribute('data-block-id')) as string
    await expect.poll(() => stored(page, otherBlock)).toBe(OTHER_TEXT)

    // The later edit, on today.
    await editTodayBlock(page)

    await page.keyboard.press('Control+z')
    await expect(row(page, TODAY_BLOCK)).toHaveText(TODAY_TEXT)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(TODAY_TEXT)
    expect(await stored(page, otherBlock)).toBe(OTHER_TEXT)

    await page.keyboard.press('Control+y')
    await expect(row(page, TODAY_BLOCK)).toHaveText(EDITED)
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(EDITED)
    expect(await stored(page, otherBlock)).toBe(OTHER_TEXT)

    // Past today's edit, the next press goes on into today's older history, not the other day's.
    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, TODAY_BLOCK)).toBe(TODAY_TEXT)
    await installIpcRecorder(page)
    await page.keyboard.press('Control+z')
    await expect
      .poll(async () => (await getInvokeCalls(page, 'undo_page_group')).map((a) => a['pageId']))
      .toEqual([TODAY_PAGE])
    expect(await getInvokeCalls(page, 'undo_op')).toEqual([])
    await expect(otherRow).toHaveText(OTHER_TEXT)
    expect(await stored(page, otherBlock)).toBe(OTHER_TEXT)
  })
})
