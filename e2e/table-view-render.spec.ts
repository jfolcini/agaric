/**
 * E2E regression for #215 — a table must stay VISIBLE in read mode.
 *
 * Before the fix, `renderBlock` had no `table` case, so a block whose
 * content parsed to a table rendered as nothing. You could insert a table
 * via `/table`, type into it while the block was focused (the TipTap editor
 * mounts real table nodes), then click away and watch the entire table
 * vanish. This test inserts a table, types into a cell, blurs the editor by
 * focusing the page title (a save, not a discard), and asserts the rendered
 * (view-mode) table is still visible.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, typeSlashCommand, waitForBoot } from './helpers'

test.describe('Table view-mode rendering (#215)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a table inserted via /table renders in read mode after blur', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    const list = await typeSlashCommand(page, 'table')
    await list.locator('#suggestion-table').click()
    await page.waitForTimeout(400)

    // Cursor lands in the first cell; type recognizable content.
    await page.keyboard.type('Quarter')
    await page.waitForTimeout(200)

    // Commit by focusing the page title: the editor saves on blur
    // (serialize → persist), unlike Escape which discards. Pressing Enter
    // inside a table cell does table-local things (not a block save), and
    // clicking a sibling block races the blur→remount. Focusing the title
    // input is an unambiguous blur target.
    await page.getByRole('textbox', { name: 'Page title' }).click()

    // Blur saves (serialize → persist → view-mode remount). The visibility
    // assertion below auto-retries until the read-mode table renders, so no
    // fixed sleep is needed to wait out the blur→save→remount.
    const table = page.locator('[data-testid="rich-table"]')
    await expect(table.first()).toBeVisible()
    await expect(table.first()).toContainText('Quarter')
  })
})
