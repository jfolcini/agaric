/**
 * E2E for edit-mode table styling. Guards that the `.ProseMirror table`
 * rules added to index.css actually apply (collapsed, bordered cells)
 * rather than falling back to raw browser defaults.
 */
import { expect, focusBlock, openPage, test, typeSlashCommand, waitForBoot } from './helpers'

test.describe('Editor table styling @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('an inserted table has collapsed, bordered cells', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    const list = await typeSlashCommand(page, 'table')
    await list.locator('#suggestion-table').click()
    // `/table` opens the size grid on 3×3; Enter inserts that.
    await expect(page.getByRole('grid', { name: 'Insert table' })).toBeFocused()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)

    const table = page.locator('[data-testid="block-editor"] table').first()
    await expect(table).toBeVisible()

    const borderCollapse = await table.evaluate((el) => getComputedStyle(el).borderCollapse)
    expect(borderCollapse).toBe('collapse')

    // Header cell carries a visible (non-zero, non-transparent) border.
    const th = page.locator('[data-testid="block-editor"] table th').first()
    const borderWidth = await th.evaluate((el) => getComputedStyle(el).borderTopWidth)
    expect(Number.parseFloat(borderWidth)).toBeGreaterThan(0)
  })
})
