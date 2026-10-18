import type { Page } from '@playwright/test'

import { expect, focusBlockById, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * The block-select cursor (#5734): keyboard focus kept apart from the selection,
 * as in a WAI-ARIA multi-select listbox. Ctrl+Space in a block selects it with
 * the cursor on it, Ctrl+ArrowDown moves the cursor without selecting, and
 * Ctrl+Space adds or removes the cursor block. In `e2e/` because the chords are
 * real key presses on the real frontend and the cursor is DOM focus and a focus
 * ring, neither of which jsdom shows; the batch action's effect is read back
 * from the mock after a reopen.
 */

const PAGE = 'Getting Started'
// SEED_IDS.BLOCK_GS_1..3 in src/lib/tauri-mock/seed.ts
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS5 = '0000000000000000000BLOCK05'

const row = (page: Page, id: string) => page.locator(`li[data-block-id="${id}"]`)
// The live region `announce()` writes to (src/lib/announcer.ts).
const announcer = (page: Page) => page.locator('#sr-announcer')
const selectBox = (page: Page, id: string) =>
  row(page, id).getByRole('checkbox', { name: 'Select block' })

/** The cursor row holds focus and paints the 3px focus ring; the row it left does not. */
async function expectCursorOn(page: Page, id: string, previous: string): Promise<void> {
  await expect(row(page, id)).toBeFocused()
  await expect(row(page, id)).toHaveCSS('box-shadow', /0px 0px 0px 3px/)
  await expect(row(page, previous)).toHaveCSS('box-shadow', 'none')
}

test.describe('Block-select cursor (#5734)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('Ctrl+Space and Ctrl+ArrowDown build a non-contiguous selection that a batch TODO acts on', async ({
    page,
  }) => {
    const toolbar = page.getByTestId('batch-toolbar')

    await focusBlockById(page, GS1)
    await page.keyboard.press('Control+Space')
    await expect(toolbar).toContainText('1 selected')
    // A screen reader hears the selection through the app announcer, and only there.
    await expect(announcer(page)).toHaveText('1 block selected')
    await expect(toolbar.getByRole('status')).toHaveCount(0)
    await expect(selectBox(page, GS1)).toBeChecked()
    await expectCursorOn(page, GS1, GS2)

    await page.keyboard.press('Control+ArrowDown')
    await expectCursorOn(page, GS2, GS1)
    await expect(toolbar).toContainText('1 selected')
    await expect(selectBox(page, GS2)).not.toBeChecked()

    await page.keyboard.press('Control+Space')
    await expect(toolbar).toContainText('2 selected')
    await expect(selectBox(page, GS2)).toBeChecked()

    await page.keyboard.press('Control+Space')
    await expect(toolbar).toContainText('1 selected')
    await expect(selectBox(page, GS2)).not.toBeChecked()
    await expect(row(page, GS2)).toBeFocused()

    await page.keyboard.press('Control+ArrowDown')
    await expectCursorOn(page, GS3, GS2)
    await page.keyboard.press('Control+Space')
    await expect(toolbar).toContainText('2 selected')

    await toolbar.getByRole('button', { name: 'TODO', exact: true }).click()
    await expect(toolbar).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect(row(page, GS1).getByTestId('task-checkbox-todo')).toBeVisible()
    await expect(row(page, GS3).getByTestId('task-checkbox-todo')).toBeVisible()
    await expect(row(page, GS2).getByTestId('task-checkbox-todo')).toHaveCount(0)
  })

  test('Ctrl+A selects every block and leaves the cursor where it was', async ({ page }) => {
    await focusBlockById(page, GS2)
    await page.keyboard.press('Escape')
    await expectCursorOn(page, GS2, GS5)

    await page.keyboard.press('Control+a')

    await expect(page.getByTestId('batch-toolbar')).toContainText('5 selected')
    await expectCursorOn(page, GS2, GS5)
  })

  test('the cursor chords act only while focus is in the list', async ({ page }) => {
    const toolbar = page.getByTestId('batch-toolbar')
    await focusBlockById(page, GS1)
    await page.keyboard.press('Control+Space')
    await expect(toolbar).toContainText('1 selected')

    // With focus on a control outside the list the chords do nothing.
    await page.getByRole('textbox', { name: 'Page title' }).click()
    await page.keyboard.press('Control+Space')
    await page.keyboard.press('Control+ArrowDown')
    await expect(toolbar).toContainText('1 selected')
    await expect(selectBox(page, GS1)).toBeChecked()

    // A click back on the row re-enables them. Ctrl+Space removes GS1, so the cursor
    // is still on it: Ctrl+ArrowDown above moved nothing.
    await row(page, GS1).click({ position: { x: 2, y: 2 } })
    await expect(row(page, GS1)).toBeFocused()
    await page.keyboard.press('Control+Space')
    await expect(toolbar).toHaveCount(0)
    await expect(announcer(page)).toHaveText('Selection cleared')
  })
})
