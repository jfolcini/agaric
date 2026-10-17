import {
  expect,
  focusBlock,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * `/table4x6` inserts a table of that size. The size follows `table` with no
 * space, because the slash menu closes on a space. In `e2e/` because the size
 * reaches the user only through the live menu, the table serializer and the
 * static table render, all of which the mock-backed build runs for real.
 */

// Rows include the header row.
const ROWS = 4
const COLS = 6

test.describe('Slash table size suffix', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test(`/table${ROWS}x${COLS} inserts a ${ROWS}×${COLS} table that persists`, async ({ page }) => {
    await focusBlock(page)

    const list = await typeSlashCommand(page, `table${ROWS}x${COLS}`)
    await list.getByRole('option', { name: new RegExp(`^TABLE ${ROWS}×${COLS}`) }).click()
    await expect(page.locator('[data-testid="block-editor"] tr')).toHaveCount(ROWS)

    await saveBlock(page, 'Escape')
    await reopenPage(page, 'Getting Started')

    // The save splits the table into its own block, so find it on the page.
    const table = page.getByTestId('rich-table')
    await expect(table.locator('tr')).toHaveCount(ROWS)
    await expect(table.locator('th')).toHaveCount(COLS)
    await expect(table.locator('td')).toHaveCount((ROWS - 1) * COLS)
  })
})
