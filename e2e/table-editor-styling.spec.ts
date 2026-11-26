/**
 * E2E for edit-mode table styling. Guards that the `.ProseMirror table`
 * rules added to index.css actually apply (a rounded frame, no cell spacing,
 * ruled cells) rather than falling back to raw browser defaults.
 */
import { expect, focusBlock, openPage, test, typeSlashCommand, waitForBoot } from './helpers'

test.describe('Editor table styling @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('an inserted table has a rounded frame and ruled cells', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    const list = await typeSlashCommand(page, 'table')
    await list.locator('#suggestion-table').click()
    // `/table` opens the size grid on 3×3; Enter inserts that.
    await expect(page.getByRole('grid', { name: 'Insert table' })).toBeFocused()
    await page.keyboard.press('Enter')

    const table = page.locator('[data-testid="block-editor"] table').first()
    await expect(table).toBeVisible()

    // A browser's table spaces its cells 2 px apart and has square corners.
    const frame = await table.evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.borderSpacing, style.borderTopLeftRadius !== '0px']
    })
    expect(frame).toEqual(['0px', true])

    // Header cell carries a visible rule between it and the next column.
    const th = page.locator('[data-testid="block-editor"] table th').first()
    const borderWidth = await th.evaluate((el) => getComputedStyle(el).borderRightWidth)
    expect(Number.parseFloat(borderWidth)).toBeGreaterThan(0)
  })
})
