import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  activePopover,
  activeSheet,
  expect,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6741, mock lane: a select defined in Settings › Properties to hold several
 * values is edited in the block drawer as its items, one chip each, and the
 * items it holds are the ones read back after leaving the page and coming back.
 */

const GS_1 = '0000000000000000000B10CK01'

function blockRow(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

async function openBlockDrawer(page: Page, blockId: string): Promise<Locator> {
  await blockRow(page, blockId).click({ button: 'right' })
  await activeMenu(page)
    .getByRole('menuitem', { name: /^Properties/ })
    .click()
  const sheet = activeSheet(page)
  await expect(sheet.getByText('Block Properties')).toBeVisible()
  return sheet
}

/** Pick `option` in the list's add control, which goes back to its placeholder once added. */
async function addItem(page: Page, sheet: Locator, option: string): Promise<void> {
  await sheet.getByRole('combobox', { name: 'Add an item to stages', exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(sheet.getByRole('button', { name: `Remove ${option}`, exact: true })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test.describe('A property that holds several values @editor', () => {
  test('two items added in the drawer are both there after reopening the page', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    const panel = page.locator('[data-testid="settings-panel-properties"]')
    await panel.getByRole('textbox', { name: 'Property key', exact: true }).fill('stages')
    await panel.getByRole('combobox', { name: 'Type', exact: true }).click()
    await page.getByRole('option', { name: 'select', exact: true }).click()
    await panel
      .getByRole('textbox', { name: 'Options, comma-separated', exact: true })
      .fill('draft, review, final')
    await panel.getByRole('checkbox', { name: 'Holds several values', exact: true }).check()
    await panel.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(panel.locator('ul > li', { hasText: 'Stages' })).toContainText('several values')

    await openPage(page, 'Getting Started')
    let sheet = await openBlockDrawer(page, GS_1)
    await sheet.getByRole('button', { name: 'Add property', exact: true }).click()
    await activePopover(page)
      .getByRole('button', { name: /^Stages/ })
      .click()
    await addItem(page, sheet, 'draft')
    await addItem(page, sheet, 'review')
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()

    await reopenPage(page, 'Getting Started')
    await expect(blockRow(page, GS_1).getByTestId('property-chip')).toHaveText([
      'Stages:draft, review',
    ])
    sheet = await openBlockDrawer(page, GS_1)
    const items = sheet.getByRole('group', { name: 'stages value', exact: true })
    await expect(items.getByRole('button', { name: /^Remove / })).toHaveCount(2)
    await expect(items.getByRole('button', { name: 'Remove draft', exact: true })).toBeVisible()
    await expect(items.getByRole('button', { name: 'Remove review', exact: true })).toBeVisible()
  })
})
