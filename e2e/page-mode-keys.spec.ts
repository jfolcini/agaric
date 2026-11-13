/**
 * Page mode's keys that change the page's structure (#5691), against the mock
 * backend, each read back from it: Delete at a block's end, Enter at and inside
 * a heading, Shift+Enter and Enter in a code block, Backspace and typing over a
 * selection across blocks, the whole page deleted and brought back, and Tab
 * with *Tab indents blocks* off.
 */

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'
import {
  PAGE_EDITOR,
  backendBlocks,
  backendTexts,
  caret,
  cursor,
  openInPageMode,
  openPageByTitle,
  seedPage,
  shownBlocks,
} from './page-mode'

test.describe('page mode’s structure keys (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Delete at a block’s end joins the next block’s text, whose children stay, and Ctrl+Z brings it back by id', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Delete joins', [
      [0, 'alpha'],
      [0, 'beta'],
      [1, 'child'],
      [0, 'gamma'],
    ])
    await openInPageMode(page, 'Delete joins', 4)
    await caret(page, 0, 'end')

    await page.keyboard.press('Delete')

    await expect
      .poll(() => backendBlocks(page, pageId))
      .toEqual([
        { id: ids[0], depth: 0, text: 'alphabeta' },
        { id: ids[2], depth: 1, text: 'child' },
        { id: ids[3], depth: 0, text: 'gamma' },
      ])
    expect(await cursor(page)).toEqual({ index: 0, offset: 'alpha'.length })

    await page.keyboard.press('Control+z')
    await expect
      .poll(() => backendBlocks(page, pageId))
      .toEqual([
        { id: ids[0], depth: 0, text: 'alpha' },
        { id: ids[1], depth: 0, text: 'beta' },
        { id: ids[2], depth: 1, text: 'child' },
        { id: ids[3], depth: 0, text: 'gamma' },
      ])
  })

  test('Enter at the end of a heading starts a plain block, and inside one keeps both halves headings', async ({
    page,
  }) => {
    const { pageId } = await seedPage(page, 'Heading Enter', [
      [0, '# Headline'],
      [0, 'beta'],
    ])
    await openInPageMode(page, 'Heading Enter', 2)

    await caret(page, 0, 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('body')
    await caret(page, 0, 'Head'.length)
    await page.keyboard.press('Enter')

    const stored = ['# Head', '# line', 'body', 'beta']
    await expect.poll(() => backendTexts(page, pageId)).toEqual(stored)
    // Out of the headings: the caret's one shows its `# `.
    await caret(page, 3, 'end')
    const content = page.locator(`${PAGE_EDITOR} .page-block-content`)
    await expect(content.locator('h1')).toHaveText(['Head', 'line'])

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Heading Enter', 4)
    expect(await backendTexts(page, pageId)).toEqual(stored)
    await expect(content.locator('h1')).toHaveText(['Head', 'line'])
    await expect(content.nth(2).locator('p')).toHaveText('body')
  })

  test('Shift+Enter breaks the line inside its block, and Enter in a code block adds a line to it', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Lines in a block', [
      [0, 'alpha'],
      [0, '```\ncode\n```'],
      [0, 'gamma'],
    ])
    await openInPageMode(page, 'Lines in a block', 3)

    await caret(page, 0, 'end')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('second')
    await caret(page, 1, 'end')
    await page.keyboard.press('Enter')
    await page.keyboard.type('more')

    const stored = [
      { id: ids[0], depth: 0, text: 'alpha\nsecond' },
      { id: ids[1], depth: 0, text: '```\ncode\nmore\n```' },
      { id: ids[2], depth: 0, text: 'gamma' },
    ]
    await expect.poll(() => backendBlocks(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Lines in a block', 3)
    expect(await backendBlocks(page, pageId)).toEqual(stored)
    await expect(page.locator(`[data-page-block-id="${ids[0]}"] br`)).toHaveCount(1)
    await expect(page.locator(`[data-page-block-id="${ids[1]}"] pre`)).toHaveText('code\nmore')
  })

  test('Backspace over a selection across blocks joins its ends and deletes the blocks between, and Ctrl+Z brings them back by id', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Selection deleted', [
      [0, 'alpha'],
      [0, 'beta'],
      [1, 'child'],
      [0, 'gamma'],
      [0, 'delta'],
    ])
    const seededRows = await backendBlocks(page, pageId)
    await openInPageMode(page, 'Selection deleted', 5)
    await caret(page, 0, 2, { index: 3, offset: 2 })

    await page.keyboard.press('Backspace')

    await expect
      .poll(() => backendBlocks(page, pageId))
      .toEqual([
        { id: ids[0], depth: 0, text: 'almma' },
        { id: ids[4], depth: 0, text: 'delta' },
      ])
    expect(await cursor(page)).toEqual({ index: 0, offset: 2 })

    await page.keyboard.press('Control+z')
    await expect.poll(() => backendBlocks(page, pageId)).toEqual(seededRows)
    expect((await shownBlocks(page)).map((b) => b.id)).toEqual(ids)
  })

  test('typing over a selection across blocks replaces it, and the blocks under the one it took stay', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Selection typed over', [
      [0, 'alpha'],
      [0, 'beta'],
      [1, 'child'],
      [0, 'gamma'],
    ])
    await openInPageMode(page, 'Selection typed over', 4)
    await caret(page, 0, 2, { index: 1, offset: 2 })

    await page.keyboard.type('Z')

    const stored = [
      { id: ids[0], depth: 0, text: 'alZta' },
      { id: ids[2], depth: 1, text: 'child' },
      { id: ids[3], depth: 0, text: 'gamma' },
    ]
    await expect.poll(() => backendBlocks(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Selection typed over', 3)
    expect(await backendBlocks(page, pageId)).toEqual(stored)
  })

  test('Ctrl+A and Backspace delete every block of the page, and Ctrl+Z brings each back by id', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Whole page deleted', [
      [0, 'alpha'],
      [1, 'child'],
      [0, 'gamma'],
    ])
    const seededRows = await backendBlocks(page, pageId)
    await openInPageMode(page, 'Whole page deleted', 3)
    await caret(page, 1, 'end')

    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await expect.poll(() => backendTexts(page, pageId)).toEqual([])

    await page.keyboard.press('Control+z')
    await expect.poll(() => backendBlocks(page, pageId)).toEqual(seededRows)
    expect((await shownBlocks(page)).map((b) => b.id)).toEqual(ids)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Whole page deleted', 3)
    expect(await backendBlocks(page, pageId)).toEqual(seededRows)
  })

  test('with Tab indents blocks off, Tab leaves the text and indents nothing, and the indent chord indents', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Tab moves focus', [
      [0, 'alpha'],
      [0, 'beta'],
    ])
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Editor')
    const tabSwitch = page.getByRole('switch', { name: 'Tab indents blocks' })
    await tabSwitch.click()
    await expect(tabSwitch).not.toBeChecked()
    await openInPageMode(page, 'Tab moves focus', 2)

    await caret(page, 1, 'end')
    await page.keyboard.press('Tab')
    await expect(page.locator(PAGE_EDITOR)).not.toBeFocused()
    // A key typed now is not the text's: nothing was indented, and nothing is typed in.
    await page.keyboard.type('x')
    expect(await shownBlocks(page)).toEqual([
      { id: ids[0], depth: 0, text: 'alpha' },
      { id: ids[1], depth: 0, text: 'beta' },
    ])

    await caret(page, 1, 'end')
    await page.keyboard.press('Control+Shift+ArrowRight')
    const indented = [
      { id: ids[0], depth: 0, text: 'alpha' },
      { id: ids[1], depth: 1, text: 'beta' },
    ]
    await expect.poll(() => backendBlocks(page, pageId)).toEqual(indented)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Tab moves focus', 2)
    expect(await shownBlocks(page)).toEqual(indented)
  })
})
