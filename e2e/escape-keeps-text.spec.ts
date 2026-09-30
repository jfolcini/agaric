import { expect, focusBlock, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * #5160 D17 — Escape keeps the typed text, leaves editing and selects the
 * block; a second Escape clears the selection, and page-level Ctrl+Z undoes
 * the edit. Every text assertion that matters is re-read after `reopenPage`,
 * which reloads the page from the mock backend.
 */

const PAGE = 'Getting Started'
const EDITED = 'Kept by Escape'

test.describe('Escape keeps the text (#5160 D17)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('Escape saves the edit, leaves editing and selects the block', async ({ page }) => {
    const blockId = await page
      .locator('[data-testid="sortable-block"]')
      .first()
      .getAttribute('data-block-id')
    const row = page.locator(
      `[data-testid="sortable-block"][data-block-id="${blockId}"] [data-testid="block-static"]`,
    )

    const editor = await focusBlock(page, 0)
    await editor.press('Control+a')
    await editor.pressSequentially(EDITED)
    await page.keyboard.press('Escape')

    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
    await expect(row).toHaveClass(/block-selected/)
    await expect(page.getByTestId('batch-toolbar')).toContainText('1')
    await expect(row).toHaveText(EDITED)

    await page.keyboard.press('Escape')
    await expect(row).not.toHaveClass(/block-selected/)
    await expect(page.getByTestId('batch-toolbar')).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect(row).toHaveText(EDITED)
  })

  test('Ctrl+Z after Escape restores the text the block had', async ({ page }) => {
    const first = page.locator('[data-testid="sortable-block"]').first()
    const blockId = await first.getAttribute('data-block-id')
    const row = page.locator(
      `[data-testid="sortable-block"][data-block-id="${blockId}"] [data-testid="block-static"]`,
    )
    const original = (await row.textContent()) ?? ''
    expect(original).not.toBe('')

    const editor = await focusBlock(page, 0)
    await editor.press('Control+a')
    await editor.pressSequentially(EDITED)
    await page.keyboard.press('Escape')
    await expect(row).toHaveText(EDITED)

    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
    await expect(row).toHaveText(original)

    await reopenPage(page, PAGE)
    await expect(row).toHaveText(original)
  })
})
