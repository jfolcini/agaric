import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  activePopover,
  activeSheet,
  chooseSelectOption,
  expect,
  ipc,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6758, mock lane: a `datetime` property declared in Settings › Properties,
 * set on a block through the Property Drawer as a local date and time, shown
 * on its chip in local time and stored as its canonical UTC value. The browser
 * runs in Berlin (UTC+1 in November) so 09:30 there is 08:30Z.
 */

const GS_1 = '0000000000000000000B10CK01'

test.use({ timezoneId: 'Europe/Berlin' })

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

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test.describe('Datetime property @editor @pages', () => {
  test('a local date and time set in the drawer shows on the chip and persists as UTC', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    const settings = page.getByTestId('settings-panel-properties')
    await settings.getByRole('textbox', { name: 'Property key' }).fill('standup')
    await chooseSelectOption(page, 'Type', 'datetime')
    await settings.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(settings.getByRole('listitem').filter({ hasText: 'Standup' })).toContainText(
      'datetime',
    )

    await openPage(page, 'Getting Started')
    const sheet = await openBlockDrawer(page, GS_1)
    await sheet.getByRole('button', { name: 'Add property', exact: true }).click()
    await activePopover(page).getByRole('button', { name: 'Standup datetime', exact: true }).click()
    const date = sheet.getByRole('textbox', { name: 'standup value, date', exact: true })
    await date.fill('2026-11-14')
    await date.press('Enter')
    const time = sheet.getByLabel('standup value, time', { exact: true })
    await time.fill('09:30')
    await time.press('Enter')
    await expect
      .poll(
        async () =>
          (
            await ipc<{ value_date: string | null } | null>(page, 'get_property', {
              blockId: GS_1,
              key: 'standup',
            })
          )?.value_date,
      )
      .toBe('2026-11-14T08:30Z')
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    const chips = blockRow(page, GS_1).getByTestId('property-chip')
    await expect(chips).toHaveText(['Standup:2026-11-14 09:30'])

    await reopenPage(page, 'Getting Started')
    await expect(chips).toHaveText(['Standup:2026-11-14 09:30'])
    const reopened = await openBlockDrawer(page, GS_1)
    await expect(reopened.getByLabel('standup value, time', { exact: true })).toHaveValue('09:30')
  })
})
