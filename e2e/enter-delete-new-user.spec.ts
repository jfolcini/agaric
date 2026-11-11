import type { Page } from '@playwright/test'

import {
  deleteBlockViaContextMenu,
  expect,
  navigateToView,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * Block-mode behaviour a new user meets in the first minute (#6547): Enter past
 * a heading's end gives a plain block, and the context menu's Delete offers an
 * Undo while Backspace on an empty block stays silent. Each test starts on an
 * empty journal day, so the rows are only the ones it types.
 */

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Block editor' })
const toasts = (page: Page) => page.locator('[data-sonner-toast]')

async function startEmptyDay(page: Page): Promise<void> {
  await waitForBoot(page)
  await navigateToView(page, 'Journal')
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByRole('button', { name: 'Add your first block' }).click()
  await expect(editor(page)).toBeFocused()
}

/** Navigate away and back, so the day is re-read from the backend. */
async function reopenDay(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
}

test.describe('Enter at a heading @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await startEmptyDay(page)
  })

  test('Enter at the end of a heading starts a plain block', async ({ page }) => {
    await editor(page).pressSequentially('# Title', { delay: 10 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await page.keyboard.insertText('body')
    await page.keyboard.press('Escape')

    const assertShape = async () => {
      await expect(rows(page).nth(0).locator('h1')).toHaveText('Title')
      await expect(rows(page).nth(1)).toHaveText('body')
      await expect(rows(page).nth(1).locator('h1, h2, h3, h4, h5, h6, blockquote')).toHaveCount(0)
    }
    await assertShape()
    await reopenDay(page)
    await assertShape()
  })

  test('Enter inside a heading keeps both halves headings', async ({ page }) => {
    await editor(page).pressSequentially('# Headline', { delay: 10 })
    await expect(editor(page).locator('h1')).toContainText('Headline')
    await selectEditorRange(page, 4, 4)
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await page.keyboard.press('Escape')

    await expect(rows(page).nth(0).locator('h1')).toHaveText('Head')
    await expect(rows(page).nth(1).locator('h1')).toHaveText('line')
  })
})

test.describe('Deleting a block @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await startEmptyDay(page)
  })

  test('the context menu Delete offers an Undo that brings the subtree back', async ({ page }) => {
    await editor(page).pressSequentially('parent', { delay: 10 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await page.keyboard.press('Tab')
    await page.keyboard.insertText('child')
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveText(['parent', 'child'])

    await deleteBlockViaContextMenu(page, rows(page).filter({ hasText: 'parent' }).first())
    await expect(rows(page)).toHaveCount(0)
    const toast = toasts(page).filter({ hasText: 'Block deleted' })
    await expect(toast).toHaveCount(1)
    await toast.getByRole('button', { name: 'Undo' }).click()

    await expect(rows(page)).toHaveText(['parent', 'child'])
    await reopenDay(page)
    await expect(rows(page)).toHaveText(['parent', 'child'])
  })

  test('Backspace on an empty block removes it without a toast', async ({ page }) => {
    await editor(page).pressSequentially('kept', { delay: 10 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await page.keyboard.press('Backspace')

    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page)).toContainText('kept')
    await expect(toasts(page)).toHaveCount(0)
  })
})
