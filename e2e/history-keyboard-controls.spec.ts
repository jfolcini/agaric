import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  activePopover,
  expect,
  ipc,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

const historyRow = (page: Page, index: number) =>
  page.getByRole('grid', { name: 'History entries' }).getByTestId(`history-item-${index}`)
const legendButton = (page: Page) => page.getByRole('button', { name: 'Op type legend' })
const legend = (page: Page) => activePopover(page).getByText('What do these mean?')
const selectedRows = (page: Page) => page.locator('[data-history-item][aria-selected="true"]')

/** `create_block` logs one op each; past one 50-entry page, Load more has more to load. */
async function openHistory(page: Page, entries: number) {
  await seedSearchBlocks(
    page,
    Array.from({ length: entries }, (_, i) => ({ content: `History row ${i}` })),
  )
  await navigateToView(page, 'History')
  await expect(historyRow(page, 0)).toBeVisible()
}

/**
 * The History list hears its keys at the document: Space toggles the cursor
 * row, and Enter opens the revert confirmation while a row is selected. On a
 * button, Enter and Space press the button instead.
 */
test.describe('Enter and Space press the focused control in the History view @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Space on the op-type legend opens it and selects no row', async ({ page }) => {
    await openHistory(page, 3)
    await legendButton(page).focus()
    await page.keyboard.press('Space')
    await expect(legend(page)).toBeVisible()
    await expect(selectedRows(page)).toHaveCount(0)
  })

  test('Enter on the legend with a row selected opens the legend, not the revert confirm', async ({
    page,
  }) => {
    await openHistory(page, 3)
    await historyRow(page, 0).click()
    await expect(historyRow(page, 0)).toHaveAttribute('aria-selected', 'true')

    await legendButton(page).focus()
    await page.keyboard.press('Enter')
    await expect(legend(page)).toBeVisible()
    await expect(activeAlertDialog(page)).toHaveCount(0)
  })

  test('Space on Load more loads the next page and selects no row', async ({ page }) => {
    await openHistory(page, 60)
    await page.getByRole('button', { name: 'Load more' }).focus()
    await page.keyboard.press('Space')
    await expect(page.getByText(/Loaded \d+ more/)).toBeAttached()
    await expect(selectedRows(page)).toHaveCount(0)
  })

  test('on the list, Space selects the cursor row and Enter opens the revert confirm', async ({
    page,
  }) => {
    await openHistory(page, 3)
    await page.getByRole('grid', { name: 'History entries' }).focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await expect(historyRow(page, 1)).toHaveAttribute('aria-selected', 'true')
    await expect(selectedRows(page)).toHaveCount(1)

    await page.keyboard.press('Enter')
    await expect(activeAlertDialog(page).getByText('Revert 1 operation?')).toBeVisible()
  })

  test('Space on a row’s Reset to this point opens its confirm and selects no row', async ({
    page,
  }) => {
    await openHistory(page, 3)
    await historyRow(page, 1).getByRole('button', { name: 'Reset to this point' }).focus()
    await page.keyboard.press('Space')
    await expect(activeAlertDialog(page).getByText(/^Restore to .+\?$/)).toBeVisible()
    await expect(selectedRows(page)).toHaveCount(0)
  })

  test('Space on a row’s Diff shows the diff and selects no row', async ({ page }) => {
    const [blockId] = await seedSearchBlocks(page, [{ content: 'Before' }])
    await ipc(page, 'edit_block', { blockId, toText: 'After' })
    await navigateToView(page, 'History')
    const diff = historyRow(page, 0).getByRole('button', { name: 'Diff' })
    await diff.focus()
    await page.keyboard.press('Space')
    await expect(historyRow(page, 0).locator('.diff-container')).toBeVisible()
    await expect(selectedRows(page)).toHaveCount(0)
  })

  test('Enter on a clicked row opens the revert confirm for it', async ({ page }) => {
    await openHistory(page, 3)
    await historyRow(page, 1).click()
    await expect(historyRow(page, 1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(activeAlertDialog(page).getByText('Revert 1 operation?')).toBeVisible()
  })
})
