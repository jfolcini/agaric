/**
 * The selection bubble's buttons from the keyboard (#6159), in block mode and in
 * page mode: a keyboard selection, Tab into the bubble, the arrows across it, then Space
 * or Enter on Bold.
 * The stored Markdown is read back after leaving the page and coming back.
 */

import type { Locator, Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

import { expect, focusBlockById, ipc, openPage, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'
const SEED_GS_1 = '0000000000000000000BLOCK01'

const stored = async (page: Page, id: string): Promise<string> =>
  (await ipc<{ content: string | null }>(page, 'get_block', { blockId: id })).content ?? ''

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, PAGE_EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/**
 * ProseMirror puts its selection back 20 ms after a focus: keys sent before then are undone.
 * A frame callback queued now runs after TipTap's delayed focus, and the timer after ProseMirror's.
 */
async function settle(editor: Locator): Promise<void> {
  await editor.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))),
  )
}

/** Select the first or last five characters with the keyboard, and wait for the editor to see it. */
async function selectWord(
  page: Page,
  editor: Locator,
  edge: 'Control+Home' | 'Control+End',
  word: string,
): Promise<void> {
  await page.keyboard.press(edge)
  // A Ctrl+Home ProseMirror undoes leaves the caret where it was (`key-ends-focus-reset.ts`).
  await expect
    .poll(() =>
      editor.evaluate((el, toStart) => {
        const { doc, selection } = (el as HTMLElement & { editor: Editor }).editor.state
        const outside = toStart
          ? doc.textBetween(0, selection.from)
          : doc.textBetween(selection.to, doc.content.size)
        return selection.empty && outside === ''
      }, edge === 'Control+Home'),
    )
    .toBe(true)
  const extend = edge === 'Control+Home' ? 'Shift+ArrowRight' : 'Shift+ArrowLeft'
  for (let i = 0; i < 5; i++) await page.keyboard.press(extend)
  // Chrome holds `selectionchange` back while keys stream in; a Tab before it lands
  // leaves the editor's selection behind.
  await expect
    .poll(() =>
      editor.evaluate((el) => {
        const { state } = (el as HTMLElement & { editor: Editor }).editor
        return state.doc.textBetween(state.selection.from, state.selection.to)
      }),
    )
    .toBe(word)
}

/** Tab from the selection to Bold, arrow to Italic and back, and press Bold with `key`. */
async function pressBold(page: Page, key: 'Enter' | ' '): Promise<void> {
  const bubble = page.getByTestId('selection-bubble-menu')
  const bold = bubble.getByRole('button', { name: 'Bold' })
  await expect(bubble).toBeVisible()
  // One tab stop (WAI-ARIA toolbar): the bubble itself is not one.
  await page.keyboard.press('Tab')
  await expect(bold).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(bubble.getByRole('button', { name: 'Italic' })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(bold).toBeFocused()
  await page.keyboard.press(key)
}

/** Bold "world" with Space and "hello" with Enter; each press hands focus back to `editor`. */
async function boldBothWords(page: Page, editor: Locator, text: Locator): Promise<void> {
  await selectWord(page, editor, 'Control+End', 'world')
  await pressBold(page, ' ')
  await expect(text.locator('strong')).toHaveText(['world'])
  await expect(editor).toBeFocused()
  await settle(editor)

  await selectWord(page, editor, 'Control+Home', 'hello')
  await pressBold(page, 'Enter')
  await expect(text.locator('strong')).toHaveText(['hello', 'world'])
  await expect(editor).toBeFocused()
}

test.describe('selection bubble from the keyboard (#6159) @editor', () => {
  test.beforeEach(async ({ page }) => {
    // Tab moves focus instead of indenting, which is how the keyboard reaches the bubble.
    await page.addInitScript(() => localStorage.setItem('agaric-tab-indents-blocks', 'false'))
    await waitForBoot(page)
  })

  test('block mode: Space and Enter on Bold bold the selection', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlockById(page, SEED_GS_1)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('hello world')

    await boldBothWords(page, editor, editor)

    await page.keyboard.press('Escape')
    await expect.poll(() => stored(page, SEED_GS_1)).toBe('**hello** **world**')
    await openViaPalette(page, 'Quick Notes')
    await openViaPalette(page, 'Getting Started')
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${SEED_GS_1}"] strong`),
    ).toHaveText(['hello', 'world'])
    expect(await stored(page, SEED_GS_1)).toBe('**hello** **world**')
  })

  test('page mode: Space and Enter on Bold bold the selection @pages', async ({ page }) => {
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Bubble keys',
      spaceId: SCOPE.space_id,
    })
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: 'hello world',
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    await openViaPalette(page, 'Bubble keys')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const text = page.locator(`${PAGE_EDITOR} [data-page-block-id="${id}"] .page-block-content`)
    await text.click()
    const editor = page.locator(PAGE_EDITOR)
    await expect(editor).toBeFocused()
    await settle(editor)

    await boldBothWords(page, editor, text)

    await expect.poll(() => stored(page, id)).toBe('**hello** **world**')
    await openViaPalette(page, 'Getting Started')
    await openViaPalette(page, 'Bubble keys')
    await expect(text.locator('strong')).toHaveText(['hello', 'world'])
    expect(await stored(page, id)).toBe('**hello** **world**')
  })
})
