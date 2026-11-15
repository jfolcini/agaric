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

/**
 * Enter in the middle of a block leaves the caret at the start of the block it
 * splits off (#6810), where every outliner puts it: what is typed next goes
 * before the moved text, and a Backspace joins the two blocks back.
 */

const PAGE_TITLE = 'Caret after a split'

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Block editor' })

async function splitHelloWorld(page: Page): Promise<void> {
  await page.keyboard.type('helloworld')
  await expect(editor(page)).toHaveText('helloworld')
  await selectEditorRange(page, 5, 5)
  await page.keyboard.press('Enter')
  await expect(rows(page)).toHaveText(['hello', 'world'])
}

test.describe('the caret after a mid-block Enter @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await createPageFromPagesView(page, PAGE_TITLE)
  })

  test('typing goes before the moved text', async ({ page }) => {
    await splitHelloWorld(page)
    await page.keyboard.type('X')
    await expect(rows(page)).toHaveText(['hello', 'Xworld'])
    await reopenPage(page, PAGE_TITLE)
    await expect(rows(page)).toHaveText(['hello', 'Xworld'])
  })

  test('a Backspace right after the split joins the blocks back', async ({ page }) => {
    await splitHelloWorld(page)
    await page.keyboard.press('Backspace')
    await expect(rows(page)).toHaveText(['helloworld'])
    await reopenPage(page, PAGE_TITLE)
    await expect(rows(page)).toHaveText(['helloworld'])
  })
})
