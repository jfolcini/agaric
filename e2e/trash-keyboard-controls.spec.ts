import {
  activeAlertDialog,
  expect,
  ipc,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * The Trash list hears its keys at the document, where Space toggles the
 * cursor row. On a button, Space presses the button instead.
 */
test.describe('Space presses the focused control in the Trash view @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    const ids = await seedSearchBlocks(page, [
      { content: 'Trashed one' },
      { content: 'Trashed two' },
    ])
    for (const blockId of ids) await ipc(page, 'delete_block', { blockId })
    await navigateToView(page, 'Trash')
    await expect(page.getByTestId('trash-item')).toHaveCount(2)
  })

  for (const [button, title] of [
    ['Restore all', 'Restore all items?'],
    ['Empty trash', 'Empty trash?'],
  ] as const) {
    test(`Space on ${button} opens its confirm and selects no row`, async ({ page }) => {
      await page.getByRole('button', { name: button, exact: true }).focus()
      await page.keyboard.press('Space')
      await expect(activeAlertDialog(page).getByText(title)).toBeVisible()
      // The open dialog hides the list from role queries; a CSS locator still sees it.
      await expect(page.locator('[data-testid="trash-item"][aria-selected="true"]')).toHaveCount(0)
    })
  }

  test('Space on the list selects the cursor row, and Escape clears it', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Trash items' })
    const row = (index: number) => grid.locator(`[data-testid="trash-item"][data-index="${index}"]`)
    await grid.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await expect(row(1)).toHaveAttribute('aria-selected', 'true')
    await expect(row(0)).toHaveAttribute('aria-selected', 'false')

    await page.keyboard.press('Escape')
    await expect(row(1)).toHaveAttribute('aria-selected', 'false')
  })
})
