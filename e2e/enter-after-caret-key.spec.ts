import type { Page } from '@playwright/test'

import {
  createPageFromPagesView,
  expect,
  navigateToView,
  reopenPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'
import { backendTexts, caret, openInPageMode, seedPage } from './page-mode'

/**
 * Enter and Backspace act on the caret a key has just moved. End, Home and the
 * arrows move the DOM caret, and ProseMirror hears of it from `selectionchange`,
 * a task later; a busy page handles two queued keys with no task between them,
 * so the second key's rule read the caret from before the first.
 */

const PAGE_TITLE = 'Caret key then Enter'

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Block editor' })

/**
 * Press `keys` while the main thread is held, so the page handles them back to
 * back. Held for longer than the 200 ms after a focus in which ProseMirror
 * takes a caret at the document's start for the browser's own and puts it back.
 */
async function pressWhileBusy(page: Page, ...keys: string[]): Promise<void> {
  const busy = page.evaluate(() => {
    const until = performance.now() + 250
    while (performance.now() < until) {
      // Hold the main thread: the keys queue behind this.
    }
  })
  await Promise.all([busy, ...keys.map((key) => page.keyboard.press(key))])
}

async function expectRows(page: Page, texts: string[]): Promise<void> {
  await expect(rows(page)).toHaveText(texts)
  await reopenPage(page, PAGE_TITLE)
  await expect(rows(page)).toHaveText(texts)
}

test.describe('a key right after a caret key acts on the moved caret @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await createPageFromPagesView(page, PAGE_TITLE)
  })

  test('End then Enter makes a block below, not a split at the old caret', async ({ page }) => {
    await page.keyboard.type('abcd')
    await expect(editor(page)).toHaveText('abcd')
    await selectEditorRange(page, 2, 2)
    await pressWhileBusy(page, 'End', 'Enter')
    await page.keyboard.type('x')
    await expectRows(page, ['abcd', 'x'])
  })

  test('Home then Backspace merges into the block above', async ({ page }) => {
    await page.keyboard.type('one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await expect(rows(page)).toHaveText(['one', 'two'])
    await pressWhileBusy(page, 'Home', 'Backspace')
    await expectRows(page, ['onetwo'])
  })
})

test.describe('page mode: a key right after a caret key acts on the moved caret @editor @pages', () => {
  test('End then Enter makes a block below, not a split at the old caret', async ({ page }) => {
    await waitForBoot(page)
    const { pageId } = await seedPage(page, 'Caret key in page mode', [[0, 'abcd']])
    await openInPageMode(page, 'Caret key in page mode', 1)
    await caret(page, 0, 2)
    await pressWhileBusy(page, 'End', 'Enter')
    await page.keyboard.type('x')
    await expect.poll(() => backendTexts(page, pageId)).toEqual(['abcd', 'x'])
  })
})
