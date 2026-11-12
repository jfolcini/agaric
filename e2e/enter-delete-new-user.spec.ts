import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
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

/** Select the first two rows from the keyboard: Escape out of the first, Shift+ArrowDown. */
async function selectFirstTwo(page: Page): Promise<void> {
  await rows(page).nth(0).locator('[data-testid="block-static"]').click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByTestId('batch-toolbar')).toContainText('2 selected')
}

async function deleteSelection(page: Page): Promise<void> {
  await page.getByTestId('batch-toolbar').getByRole('button', { name: 'Delete' }).click()
  await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()
}

/** Each row's text box, as `top,left`: what a layout shift moves. */
function textBoxes(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"] [data-testid="block-static"]')
    .evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect()
        return `${Math.round(box.top)},${Math.round(box.left)}`
      }),
    )
}

test.describe('Escape from a block @editor @journal', () => {
  test.beforeEach(async ({ page }) => {
    await startEmptyDay(page)
    // A task, then a parent with a child: the rows a selection used to move.
    await editor(page).pressSequentially('task', { delay: 10 })
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('parent')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.insertText('child')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveText(['task', 'parent', 'child'])
    await expect(page.locator('.block-selected')).toHaveCount(0)
  })

  test('Escape selects the block without a bar, a shift or a hidden checkbox', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const atRest = await textBoxes(page)

    for (const text of ['task', 'parent']) {
      const row = rows(page).filter({ hasText: text }).first()
      await row.locator('[data-testid="block-static"]').click()
      await expect(editor(page)).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(row.locator('.block-selected')).toHaveCount(1)

      await expect(page.getByTestId('batch-toolbar')).toHaveCount(0)
      await expect(page.getByText('Delete').locator('visible=true')).toHaveCount(0)
      await expect(rows(page).getByTestId('task-checkbox-todo')).toBeVisible()
      expect(await textBoxes(page)).toEqual(atRest)
      await page.keyboard.press('Escape')
    }
  })

  test('a second selected block brings the batch bar', async ({ page }) => {
    await rows(page).nth(1).locator('[data-testid="block-static"]').click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('batch-toolbar')).toHaveCount(0)

    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.getByTestId('batch-toolbar')).toContainText('2 selected')
    await expect(rows(page).getByTestId('task-checkbox-todo')).toBeVisible()
  })
})

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

  test('the batch bar Delete offers one Undo that brings every selected block back', async ({
    page,
  }) => {
    await editor(page).pressSequentially('one', { delay: 10 })
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('two')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('three')
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveText(['one', 'two', 'three'])

    await selectFirstTwo(page)
    await deleteSelection(page)
    await expect(rows(page)).toHaveText(['three'])
    const toast = toasts(page).filter({ hasText: 'Deleted 2 blocks' })
    await expect(toast).toHaveCount(1)
    await toast.getByRole('button', { name: 'Undo' }).click()

    await expect(rows(page)).toHaveText(['one', 'two', 'three'])
    await reopenDay(page)
    await expect(rows(page)).toHaveText(['one', 'two', 'three'])
  })

  test('the batch Undo brings back a parent selected with its child', async ({ page }) => {
    await editor(page).pressSequentially('parent', { delay: 10 })
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.insertText('child')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.insertText('after')
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveText(['parent', 'child', 'after'])

    await selectFirstTwo(page)
    await deleteSelection(page)
    await expect(rows(page)).toHaveText(['after'])
    await toasts(page)
      .filter({ hasText: 'Deleted 2 blocks' })
      .getByRole('button', { name: 'Undo' })
      .click()

    await expect(rows(page)).toHaveText(['parent', 'child', 'after'])
    await reopenDay(page)
    await expect(rows(page)).toHaveText(['parent', 'child', 'after'])
  })

  test('Backspace on an empty block removes it without a toast', async ({ page }) => {
    await editor(page).pressSequentially('kept', { delay: 10 })
    await page.keyboard.press('Enter')
    await expect(rows(page)).toHaveCount(2)
    await page.keyboard.press('Backspace')

    await expect(rows(page)).toHaveCount(1)
    // Read once: a retrying `toHaveCount(0)` waits out a toast's lifetime and passes.
    expect(await toasts(page).count()).toBe(0)
    await expect(rows(page)).toContainText('kept')
  })
})
