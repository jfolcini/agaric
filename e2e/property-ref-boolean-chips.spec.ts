import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  activePopover,
  activeSheet,
  chooseSelectOption,
  expect,
  navigateToView,
  openPage,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5736, mock lane: a boolean property is a checkbox in the block drawer and a
 * Yes/No chip on the block; a ref property's chip shows its page's current
 * title and opens that page. Every row these read is one the mock stores and
 * the resolve cache it fills, so each failure shows here.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`, `SEED_IDS`): GS_1 is the first block of
 * Getting Started and carries no properties.
 */

const GS_1 = '0000000000000000000BLOCK01'

function blockRow(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

/** Define `key` in Settings → Properties. */
async function defineInSettings(page: Page, key: string, type: string): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
  const settings = page.getByTestId('settings-panel-properties')
  await settings.getByRole('textbox', { name: 'Property key' }).fill(key)
  await chooseSelectOption(page, 'Type', type)
  await settings.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(settings.getByRole('listitem').filter({ hasText: key })).toContainText(type)
}

/**
 * Navigate away, then back to `title` from the Pages list. Not `reopenPage`:
 * its text match also hits the recently-visited bar's chip once a page was left.
 */
async function reopenFromPages(page: Page, title: string): Promise<void> {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Tags', exact: true })
    .click()
  await expect(page.getByTestId('header-label')).toContainText('Tags')
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  // The row's title span; the recently-visited bar's chip carries the same title, on a button.
  await page.locator(`span[title="${title}"]`).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
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

async function addFromDefinition(page: Page, sheet: Locator, name: string): Promise<void> {
  await sheet.getByRole('button', { name: 'Add property', exact: true }).click()
  await activePopover(page).getByRole('button', { name, exact: true }).click()
}

async function renameOpenPage(page: Page, title: string): Promise<void> {
  const titleEl = page.locator('[aria-label="Page title"]')
  await titleEl.fill(title)
  await titleEl.press('Enter')
  await expect(page.locator('[data-sonner-toast]').getByText('Page renamed')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('a boolean toggled in the drawer is checked and reads Yes after navigating away and back', async ({
  page,
}) => {
  await defineInSettings(page, 'billable', 'boolean')
  await openPage(page, 'Getting Started')
  const sheet = await openBlockDrawer(page, GS_1)
  await addFromDefinition(page, sheet, 'Billable boolean')
  const box = sheet.getByRole('checkbox', { name: 'Toggle boolean property billable' })
  await expect(box).not.toBeChecked()
  await box.click()
  await expect(box).toBeChecked()
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()

  await reopenFromPages(page, 'Getting Started')
  await expect(blockRow(page, GS_1).getByTestId('property-chip')).toHaveText(['Billable:Yes'])
  const reopened = await openBlockDrawer(page, GS_1)
  await expect(
    reopened.getByRole('checkbox', { name: 'Toggle boolean property billable' }),
  ).toBeChecked()
})

test('a ref chip shows its page renamed after navigating away and back, and opens it', async ({
  page,
}) => {
  await defineInSettings(page, 'owner', 'ref')
  await openPage(page, 'Getting Started')
  const sheet = await openBlockDrawer(page, GS_1)
  await addFromDefinition(page, sheet, 'Owner ref')
  await sheet.getByRole('button', { name: 'owner value', exact: true }).click()
  await activePopover(page).getByRole('button', { name: 'Quick Notes', exact: true }).click()
  await expect(sheet.getByRole('button', { name: 'owner value', exact: true })).toHaveText(
    'Quick Notes',
  )
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()

  await openPage(page, 'Quick Notes')
  await renameOpenPage(page, 'Inbox')

  await reopenFromPages(page, 'Getting Started')
  const row = blockRow(page, GS_1)
  await expect(row.getByTestId('property-chip')).toHaveText(['Owner:Inbox'])
  await row.getByRole('button', { name: 'Open Inbox', exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Inbox')
})
