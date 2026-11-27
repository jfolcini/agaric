import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * #5302: Home/End/PageUp/PageDown move the Due panel's cursor across a long
 * list. Focus has to land on the cursor row, or the ring disappears and the
 * next key goes nowhere.
 */

const TASKS = 45

test.describe('Due panel keyboard jumps (#5302) @journal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedSearchBlocks(
      page,
      Array.from({ length: TASKS }, (_, i) => ({
        content: `long task ${String(i).padStart(2, '0')}`,
        todo: 'TODO',
        due: 0,
      })),
    )
    // Leave and re-enter the journal so the Due panel refetches the seeded tasks.
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
  })

  test('End, Home and PageDown keep DOM focus on the cursor row', async ({ page }) => {
    const rows = page.getByTestId('due-panel-item')
    const focusedRow = page.locator('[data-testid="due-panel-item"]:focus')
    await expect(rows.first()).toBeVisible()

    await rows.first().focus()
    const firstRowText = (await rows.first().textContent()) ?? ''
    const lastRowText = (await rows.last().textContent()) ?? ''

    await page.keyboard.press('End')
    await expect(focusedRow).toHaveText(lastRowText)
    await expect(focusedRow).toHaveClass(/list-cursor/)

    await page.keyboard.press('Home')
    await expect(focusedRow).toHaveText(firstRowText)
    await expect(focusedRow).toHaveClass(/list-cursor/)

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('PageDown')
      await expect(focusedRow).toHaveClass(/list-cursor/)
    }

    // The next key still reaches the list.
    const beforeArrow = (await focusedRow.textContent()) ?? ''
    await page.keyboard.press('ArrowDown')
    await expect(focusedRow).toHaveClass(/list-cursor/)
    await expect(focusedRow).not.toHaveText(beforeArrow)
  })
})
