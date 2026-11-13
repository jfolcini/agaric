import type { Page } from '@playwright/test'

import { pageRow } from './domain'
import {
  activeAlertDialog,
  expect,
  ipc,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

const trashGrid = (page: Page) => page.getByRole('grid', { name: 'Trash items' })
// CSS, not roles: an open dialog hides the list from role queries.
const trashRow = (page: Page, index: number) =>
  page.locator(`[data-testid="trash-item"][data-index="${index}"]`)
const selectedTrashRows = (page: Page) =>
  page.locator('[data-testid="trash-item"][aria-selected="true"]')
const historyGrid = (page: Page) => page.getByRole('grid', { name: 'History entries' })
const historyRow = (page: Page, index: number) => page.getByTestId(`history-item-${index}`)
const selectedHistoryRows = (page: Page) =>
  page.locator('[data-history-item][aria-selected="true"]')
const batchToolbar = (page: Page) => page.getByRole('toolbar', { name: /selected$/ })
const selectListbox = (page: Page) => page.locator('[data-slot="select-content"]')

async function openTrash(page: Page, items: number) {
  const ids = await seedSearchBlocks(
    page,
    Array.from({ length: items }, (_, i) => ({ content: `Trashed ${i}` })),
  )
  for (const blockId of ids) await ipc(page, 'delete_block', { blockId })
  await navigateToView(page, 'Trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(items)
}

async function openHistory(page: Page) {
  await seedSearchBlocks(
    page,
    Array.from({ length: 3 }, (_, i) => ({ content: `History row ${i}` })),
  )
  await navigateToView(page, 'History')
  await expect(historyRow(page, 0)).toBeVisible()
}

/** Select the Pages row titled `title` through its checkbox. */
async function selectPage(page: Page, title: string) {
  await pageRow(page, title).getByRole('checkbox', { name: 'Select page' }).click()
  await expect(batchToolbar(page)).toBeVisible()
}

/**
 * The list views hear their keys at the document. A key pressed inside an open
 * overlay (a confirm dialog, a select's listbox) belongs to the overlay: Escape
 * closes it and keeps the list's selection, and the arrows leave the cursor.
 */
test.describe('keys inside an open overlay leave the list behind it alone @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Escape in Trash’s Empty trash confirm keeps the selection, as No does', async ({
    page,
  }) => {
    await openTrash(page, 2)
    await trashGrid(page).focus()
    await page.keyboard.press('Space')
    await expect(trashRow(page, 0)).toHaveAttribute('aria-selected', 'true')

    const emptyTrash = page.getByRole('button', { name: 'Empty trash', exact: true })
    const dialog = activeAlertDialog(page)
    await emptyTrash.click()
    await expect(dialog.getByRole('button', { name: 'No' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(selectedTrashRows(page)).toHaveCount(1)

    await emptyTrash.click()
    await dialog.getByRole('button', { name: 'No' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(selectedTrashRows(page)).toHaveCount(1)
  })

  test('Escape in History’s revert confirm keeps the selection', async ({ page }) => {
    await openHistory(page)
    await historyRow(page, 0).click()
    await expect(historyRow(page, 0)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    const dialog = activeAlertDialog(page)
    await expect(dialog.getByText('Revert 1 operation?')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(selectedHistoryRows(page)).toHaveCount(1)
  })

  test('arrows in History’s open op-type select leave the list cursor where it was', async ({
    page,
  }) => {
    await openHistory(page)
    await expect(historyRow(page, 0)).toHaveAttribute('tabindex', '0')
    await page.getByRole('combobox', { name: 'Filter by operation type' }).focus()
    await page.keyboard.press('Enter')
    await expect(selectListbox(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(selectListbox(page)).toHaveCount(0)

    await expect(historyRow(page, 0)).toHaveAttribute('tabindex', '0')
    await expect(historyRow(page, 1)).toHaveAttribute('tabindex', '-1')
  })

  test('Escape in Pages’ delete confirm keeps the selection', async ({ page }) => {
    await navigateToView(page, 'Pages')
    await selectPage(page, 'Quick Notes')
    await pageRow(page, 'Meeting Notes Template')
      .getByRole('button', { name: 'Delete page' })
      .click()
    const dialog = activeAlertDialog(page)
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(batchToolbar(page)).toHaveAccessibleName('1 selected')
  })

  test('arrows and Escape in Pages’ open property select leave the list alone', async ({
    page,
  }) => {
    await navigateToView(page, 'Pages')
    await expect(pageRow(page, 'Getting Started')).toHaveAttribute('aria-selected', 'true')
    await selectPage(page, 'Quick Notes')
    await page.getByTestId('page-batch-set-property-btn').click()
    await page.getByTestId('page-batch-property-select').focus()
    await page.keyboard.press('Enter')
    await expect(selectListbox(page)).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(selectListbox(page)).toHaveCount(0)

    await expect(pageRow(page, 'Getting Started')).toHaveAttribute('aria-selected', 'true')
    await expect(batchToolbar(page)).toHaveAccessibleName('1 selected')
  })
})

/**
 * A batch toolbar is there only while something is selected. When one of its
 * own buttons empties the selection, focus goes back to the list's Tab stop
 * instead of falling to <body> with the toolbar, and the next arrow moves the
 * cursor.
 */
test.describe('emptying the selection from the batch toolbar returns focus to the list @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Trash: Deselect all', async ({ page }) => {
    await openTrash(page, 3)
    await trashGrid(page).focus()
    await page.keyboard.press('Space')
    await batchToolbar(page).getByRole('button', { name: 'Deselect all' }).focus()
    await page.keyboard.press('Enter')
    await expect(batchToolbar(page)).toHaveCount(0)

    await expect(trashGrid(page)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(trashRow(page, 1)).toHaveAttribute('tabindex', '0')
  })

  test('Trash: Restore selected, which removes the restored rows', async ({ page }) => {
    await openTrash(page, 5)
    await trashGrid(page).focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await expect(selectedTrashRows(page)).toHaveCount(2)
    await batchToolbar(page).getByRole('button', { name: 'Restore selected' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('trash-item')).toHaveCount(3)
    await expect(batchToolbar(page)).toHaveCount(0)

    await expect(trashGrid(page)).toBeFocused()
    await expect(trashRow(page, 1)).toHaveAttribute('tabindex', '0')
    await page.keyboard.press('ArrowDown')
    await expect(trashRow(page, 2)).toHaveAttribute('tabindex', '0')
  })

  test('History: Clear selection', async ({ page }) => {
    await openHistory(page)
    await historyGrid(page).focus()
    await page.keyboard.press('Space')
    await expect(selectedHistoryRows(page)).toHaveCount(1)
    await batchToolbar(page).getByRole('button', { name: 'Clear selection' }).focus()
    await page.keyboard.press('Enter')
    await expect(batchToolbar(page)).toHaveCount(0)

    await expect(historyRow(page, 0)).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(historyRow(page, 1)).toHaveAttribute('tabindex', '0')
  })

  test('Pages: Clear selection', async ({ page }) => {
    await navigateToView(page, 'Pages')
    await selectPage(page, 'Quick Notes')
    await batchToolbar(page).getByRole('button', { name: 'Clear selection' }).focus()
    await page.keyboard.press('Enter')
    await expect(batchToolbar(page)).toHaveCount(0)

    await expect(page.getByRole('grid')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(pageRow(page, 'Meeting Notes Template')).toHaveAttribute('aria-selected', 'true')
  })
})
