import type { Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * `/table` opens the size grid at the caret, starting on 3×3; arrows resize it,
 * Enter inserts, Escape inserts nothing. In `e2e/` because the grid only works
 * while focus in it leaves the roving editor mounted (`data-editor-portal`), a
 * focus path jsdom does not run, and the mock-backed build runs the menu, the
 * table serializer and the static table render for real.
 */

// `SEED_IDS.BLOCK_GS_1` in src/lib/tauri-mock/seed.ts, the first block of "Getting Started".
const GS_1 = '0000000000000000000BLOCK01'
const GS_1_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'

async function openTableGrid(page: Page) {
  const editor = await focusBlockById(page, GS_1)
  const list = await typeSlashCommand(page, 'table')
  await expect(list.locator('#suggestion-table')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  const grid = page.getByRole('grid', { name: 'Insert table' })
  await expect(grid).toBeFocused()
  return { editor, grid }
}

test.describe('Slash table grid @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('arrows resize the grid from 3×3 and Enter inserts a table that persists', async ({
    page,
  }) => {
    const { editor, grid } = await openTableGrid(page)
    await expect(page.getByTestId('table-picker-label')).toHaveText('3 × 3')

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('table-picker-label')).toHaveText('4 × 4')
    await page.keyboard.press('Enter')

    // Rows include the header row.
    await expect(grid).toBeHidden()
    await expect(editor).toBeFocused()
    await expect(page.locator('[data-testid="block-editor"] tr')).toHaveCount(4)

    await saveBlock(page, 'Escape')
    await reopenPage(page, 'Getting Started')

    // The save splits the table into its own block, so find it on the page.
    const table = page.getByTestId('rich-table')
    await expect(table.locator('tr')).toHaveCount(4)
    await expect(table.locator('th')).toHaveCount(4)
    await expect(table.locator('td')).toHaveCount(12)
  })

  test('Enter on the opened grid inserts a 3×3 table', async ({ page }) => {
    const { editor } = await openTableGrid(page)
    await page.keyboard.press('Enter')

    await expect(editor).toBeFocused()
    const table = page.locator('[data-testid="block-editor"] table')
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table.locator('th')).toHaveCount(3)
  })

  test('Escape closes the grid, inserts nothing and leaves the text as it was', async ({
    page,
  }) => {
    const { editor, grid } = await openTableGrid(page)
    await page.keyboard.press('Escape')

    await expect(grid).toBeHidden()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText(GS_1_TEXT)
    await expect(page.locator('[data-testid="block-editor"] table')).toHaveCount(0)

    await saveBlock(page, 'Escape')
    await reopenPage(page, 'Getting Started')
    await expect(page.locator(`[data-testid="block-static"][data-block-id="${GS_1}"]`)).toHaveText(
      GS_1_TEXT,
    )
    await expect(page.getByTestId('rich-table')).toHaveCount(0)
  })

  test('a click on the page title closes the grid and keeps focus there', async ({ page }) => {
    const { grid } = await openTableGrid(page)
    const title = page.getByRole('textbox', { name: 'Page title' })
    await title.click()

    await expect(grid).toBeHidden()
    await expect(title).toBeFocused()
    await expect(page.locator('table')).toHaveCount(0)
  })
})
