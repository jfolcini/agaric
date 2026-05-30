/**
 * E2E for #215 table row/column operations.
 *
 * The "Table" toolbar trigger only appears when the selection is inside a
 * table cell; its popover runs TipTap table commands on the live editor.
 * This test stays entirely in EDIT mode (no blur/commit), so it avoids the
 * table-cell blur race: insert a table via `/table`, confirm the trigger
 * appears, then insert a row and assert the editor's table grew.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, typeSlashCommand, waitForBoot } from './helpers'

test.describe('Table ops toolbar (#215)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the Table trigger appears in a table and "insert row below" adds a row', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    const list = await typeSlashCommand(page, 'table')
    await list.locator('#suggestion-table').click()
    await page.waitForTimeout(400)

    // Cursor is now in the first cell → the contextual trigger is visible
    // (the aria-hidden sentinel copy is excluded from the accessible name).
    const trigger = page.getByRole('button', { name: 'Table', exact: true })
    await expect(trigger).toBeVisible()

    // Count rows in the live editor's table before the op.
    const editorTable = page.locator('[data-testid="block-editor"] table')
    const rowsBefore = await editorTable.locator('tr').count()

    await trigger.click()
    await page.getByTestId('table-op-insert-row-below').click()
    await page.waitForTimeout(300)

    const rowsAfter = await editorTable.locator('tr').count()
    expect(rowsAfter).toBe(rowsBefore + 1)
  })
})
