import type { Page } from '@playwright/test'

import { runSlashCommand } from './domain'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  replaceEditorText,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6556 — Ctrl+Z (Ctrl+Y / Ctrl+Shift+Z) inside a block whose editor history is
 * empty runs the page's undo (redo) and keeps editing, instead of doing nothing.
 */

const GS_2 = '0000000000000000000BLOCK02'
const GS_3 = '0000000000000000000BLOCK03'
const GS_1 = '0000000000000000000BLOCK01'
const GS_3_TEXT = 'Create new blocks by pressing Enter at the end of any block.'

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const editor = (page: Page) => page.locator('[data-testid="block-editor"] [contenteditable="true"]')
const stored = async (page: Page, blockId: string) =>
  (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
const editingId = (page: Page) =>
  page
    .locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
    .getAttribute('data-block-id')
const row = (page: Page, blockId: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)

/** The press left the caret in an editor on `blockId`. */
async function expectEditing(page: Page, blockId: string): Promise<void> {
  await expect(editor(page)).toBeFocused()
  expect(await editingId(page)).toBe(blockId)
}

test.describe('Ctrl+Z in a block with no editor history runs the page undo @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('after Enter, the new block is taken back and the caret returns to its source', async ({
    page,
  }) => {
    const before = await rows(page).count()
    await focusBlockById(page, GS_3)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(before + 1)
    const created = await editingId(page)
    expect(created).not.toBe(GS_3)

    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(before)
    await expectEditing(page, GS_3)

    await page.keyboard.press('Control+y')
    await expect(rows(page)).toHaveCount(before + 1)
    await expect(editor(page)).toBeFocused()
  })

  test('after Escape and a click back into the block, its edit is undone in place', async ({
    page,
  }) => {
    await focusBlockById(page, GS_3)
    await replaceEditorText(page, 'changed')
    await saveBlock(page, 'Escape')
    await expect.poll(() => stored(page, GS_3)).toBe('changed')
    await focusBlockById(page, GS_3)

    await page.keyboard.press('Control+z')
    await expect(editor(page)).toHaveText(GS_3_TEXT)
    await expect.poll(() => stored(page, GS_3)).toBe(GS_3_TEXT)
    await expectEditing(page, GS_3)

    await page.keyboard.press('Control+Shift+z')
    await expect(editor(page)).toHaveText('changed')
    await expect.poll(() => stored(page, GS_3)).toBe('changed')
    await expectEditing(page, GS_3)
  })

  test('after moving to another block, the edit left behind is undone', async ({ page }) => {
    await focusBlockById(page, GS_3)
    await replaceEditorText(page, 'changed')
    await focusBlockById(page, GS_1)
    await expect.poll(() => stored(page, GS_3)).toBe('changed')

    await page.keyboard.press('Control+z')
    await expect(row(page, GS_3)).toHaveText(GS_3_TEXT)
    await expect.poll(() => stored(page, GS_3)).toBe(GS_3_TEXT)
    await expectEditing(page, GS_1)

    await page.keyboard.press('Control+y')
    await expect(row(page, GS_3)).toHaveText('changed')
    await expectEditing(page, GS_1)
  })

  test('after a Backspace merge, both blocks come back', async ({ page }) => {
    const before = await rows(page).count()
    const gs2 = await stored(page, GS_2)
    await focusBlockById(page, GS_3)
    await selectEditorRange(page, 0, 0)
    await page.keyboard.press('Backspace')
    await expect(rows(page)).toHaveCount(before - 1)

    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(before)
    await expect.poll(() => stored(page, GS_2)).toBe(gs2)
    await expect(row(page, GS_3)).toHaveText(GS_3_TEXT)
    await expectEditing(page, GS_2)

    await page.keyboard.press('Control+Shift+z')
    await expect(rows(page)).toHaveCount(before - 1)
    await expect(editor(page)).toBeFocused()
  })

  test('after /h2, the heading and the text typed before it are undone', async ({ page }) => {
    await focusBlockById(page, GS_3)
    await page.keyboard.press('End')
    await page.keyboard.type(' typed')
    await runSlashCommand(page, 'h2', 'Heading 2 — Medium heading')
    await expect.poll(() => stored(page, GS_3)).toMatch(/^## .* typed\s*$/)
    const heading = await stored(page, GS_3)

    await page.keyboard.press('Control+z')
    await expect.poll(() => stored(page, GS_3)).toBe(GS_3_TEXT)
    await expect(editor(page)).toHaveText(GS_3_TEXT)
    await expectEditing(page, GS_3)

    await page.keyboard.press('Control+y')
    await expect.poll(() => stored(page, GS_3)).toBe(heading)
    await expectEditing(page, GS_3)
  })

  test('unsaved text outside the editor history is flushed before the page undo', async ({
    page,
  }) => {
    await focusBlockById(page, GS_3)
    // A change the editor history does not record, as a text-rewriting slash command makes.
    await editor(page).evaluate((el) => {
      const { view } = (
        el as HTMLElement & {
          editor: {
            view: {
              state: {
                tr: {
                  insertText: (
                    t: string,
                    at: number,
                  ) => { setMeta: (key: string, value: boolean) => unknown }
                }
              }
              dispatch: (tr: unknown) => void
            }
          }
        }
      ).editor
      view.dispatch(view.state.tr.insertText('unsaved ', 1).setMeta('addToHistory', false))
    })
    await expect(editor(page)).toHaveText(`unsaved ${GS_3_TEXT}`)

    await page.keyboard.press('Control+z')
    await expect(editor(page)).toHaveText(GS_3_TEXT)
    await expect.poll(() => stored(page, GS_3)).toBe(GS_3_TEXT)
    await expectEditing(page, GS_3)

    // The redo brings the flushed text back: it was saved, not dropped.
    await page.keyboard.press('Control+y')
    await expect(editor(page)).toHaveText(`unsaved ${GS_3_TEXT}`)
    await expect.poll(() => stored(page, GS_3)).toBe(`unsaved ${GS_3_TEXT}`)
  })

  test('typing in the block is still undone by the editor, one run at a time', async ({ page }) => {
    await focusBlockById(page, GS_3)
    await page.keyboard.press('End')
    await page.keyboard.type(' one')
    // A second run of typing elsewhere is a second step of the editor history.
    await selectEditorRange(page, 0, 0)
    await page.keyboard.type('two ')
    await expect(editor(page)).toHaveText(`two ${GS_3_TEXT} one`)

    await page.keyboard.press('Control+z')
    await expect(editor(page)).toHaveText(`${GS_3_TEXT} one`)
    await expectEditing(page, GS_3)
    await page.keyboard.press('Control+Shift+z')
    await expect(editor(page)).toHaveText(`two ${GS_3_TEXT} one`)
    await expectEditing(page, GS_3)
  })
  test('typing already saved is one page step after the editor takes it back', async ({ page }) => {
    await focusBlockById(page, GS_3)
    await page.keyboard.press('End')
    await page.keyboard.type(' typed')
    await expect.poll(() => stored(page, GS_3)).toBe(`${GS_3_TEXT} typed`)

    await page.keyboard.press('Control+z')
    await expect(editor(page)).toHaveText(GS_3_TEXT)
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
    await expect(editor(page)).toHaveText(GS_3_TEXT)
    await expect.poll(() => stored(page, GS_3)).toBe(GS_3_TEXT)
    await expectEditing(page, GS_3)
  })
})
