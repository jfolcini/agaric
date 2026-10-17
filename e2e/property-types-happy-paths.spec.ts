import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  activePopover,
  activeSheet,
  chooseSelectOption,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5736, mock lane: typed property values in the block drawer, the chip row,
 * the References sort and the page Properties table. Every row these surfaces
 * read is one the mock stores, so each failure shows here.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`, `SEED_IDS`): MTG_1 on Meetings carries
 * `context: @office` and `project: alpha`; `reviewer` is a text definition no
 * block uses; Quick Notes has no properties.
 */

const GETTING_STARTED = '00000000000000000000PAGE01'
const QUICK_NOTES = '00000000000000000000PAGE02'
const GS_1 = '0000000000000000000BLOCK01'
const MTG_1 = '0000000000000000000BLOCK17'

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>
}

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

test.describe('Number property', () => {
  test('12 set in the drawer shows on the chip after reopening; text is refused', async ({
    page,
  }) => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    const settings = page.getByTestId('settings-panel-properties')
    await settings.getByRole('textbox', { name: 'Property key' }).fill('estimate')
    await chooseSelectOption(page, 'Type', 'number')
    await settings.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(settings.getByRole('listitem').filter({ hasText: 'Estimate' })).toContainText(
      'number',
    )

    await openPage(page, 'Getting Started')
    const sheet = await openBlockDrawer(page, GS_1)
    await sheet.getByRole('button', { name: 'Add property', exact: true }).click()
    await activePopover(page).getByRole('button', { name: 'Estimate number', exact: true }).click()
    const value = sheet.getByRole('textbox', { name: 'estimate value', exact: true })
    await value.fill('12')
    await value.press('Enter')
    // A chip reads `value_text` too, so only the stored row tells 12 from "12".
    await expect
      .poll(
        async () =>
          (
            await ipc<{ value_num: number | null } | null>(page, 'get_property', {
              blockId: GS_1,
              key: 'estimate',
            })
          )?.value_num,
      )
      .toBe(12)
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()

    await reopenPage(page, 'Getting Started')
    const chips = blockRow(page, GS_1).getByTestId('property-chip')
    await expect(chips).toHaveText(['Estimate:12'])

    await openBlockDrawer(page, GS_1)
    await value.fill('abc')
    await value.press('Enter')
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Invalid number value' }),
    ).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()

    await reopenPage(page, 'Getting Started')
    await expect(chips).toHaveText(['Estimate:12'])
  })

  // Creation order and text order ("12" < "9") both list twelve first; only a
  // numeric sort lists nine first.
  test('sorts the References panel numerically', async ({ page }) => {
    // Set-up, not under test: the definition and the two referrers.
    await ipc(page, 'create_property_def', { key: 'estimate', valueType: 'number', options: null })
    const [twelve, nine] = await seedSearchBlocks(page, [
      { content: `Estimate twelve on [[${GETTING_STARTED}]]` },
      { content: `Estimate nine on [[${GETTING_STARTED}]]` },
    ])
    await ipc(page, 'set_property', { blockId: twelve, key: 'estimate', value: { value_num: 12 } })
    await ipc(page, 'set_property', { blockId: nine, key: 'estimate', value: { value_num: 9 } })

    await openPage(page, 'Getting Started')
    const references = page.getByTestId('linked-references')
    const notes = references.getByText(/^Estimate (twelve|nine) on/)
    await expect(notes).toHaveText([/twelve/, /nine/])

    await references.getByRole('combobox', { name: 'Sort by' }).click()
    await page.getByRole('option', { name: 'estimate', exact: true }).click()
    await expect(notes).toHaveText([/nine/, /twelve/])
  })
})

test.describe('Boolean property', () => {
  // The page Properties table is where a boolean renders as a checkbox; the
  // block drawer shows it as a text input.
  test('a toggled checkbox in the page Properties table stays checked after reopening', async ({
    page,
  }) => {
    await openPage(page, 'Quick Notes')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add property', exact: true }).click()
    const picker = activePopover(page)
    await picker.getByRole('textbox', { name: 'Search definitions' }).fill('billable')
    await picker.getByRole('button', { name: /^Create "billable"/ }).click()
    await picker.getByRole('combobox', { name: 'Value type' }).click()
    await page.getByRole('option', { name: 'boolean', exact: true }).click()
    await picker.getByRole('button', { name: 'Create definition', exact: true }).click()

    const box = page.getByRole('checkbox', { name: 'Toggle boolean property billable' })
    await expect(box).not.toBeChecked()
    await box.click()
    await expect(box).toBeChecked()

    await reopenPage(page, 'Quick Notes')
    await page.getByRole('button', { name: 'Properties (1)', exact: true }).click()
    await expect(box).toBeChecked()
  })
})

test.describe('URL-looking property value', () => {
  test('its chip opens the URL; a plain value has no open-link control', async ({ page }) => {
    await ipc(page, 'set_property', {
      blockId: MTG_1,
      key: 'reviewer',
      value: { value_text: 'https://example.com' },
    })
    await openPage(page, 'Meetings')
    const row = blockRow(page, MTG_1)
    await expect(row.getByTestId('property-chip')).toHaveText([
      'Context:@office',
      'Project:alpha',
      'Reviewer:https://example.com',
    ])
    const openLink = row.getByRole('button', { name: /^Open / })
    await expect(openLink).toHaveCount(1)

    // Opening a URL leaves nothing to re-query; the call to the opener is the effect.
    await installIpcRecorder(page)
    await openLink.click()
    await expect
      .poll(() => getInvokeCalls(page, 'plugin:shell|open'))
      .toEqual([{ path: 'https://example.com' }])
  })
})

test.describe('Chip row overflow', () => {
  test('eight properties show the inline cap and fold the rest into +N', async ({ page }) => {
    await seedSearchBlocks(page, [
      {
        content: 'Eight properties',
        parentId: QUICK_NOTES,
        props: { k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4', k5: 'v5', k6: 'v6', k7: 'v7', k8: 'v8' },
      },
    ])

    await openPage(page, 'Quick Notes')
    const row = page.getByTestId('sortable-block').filter({ hasText: 'Eight properties' })
    // `INLINE_PROPERTY_LIMITS.desktop` chips, then the rest as one badge.
    await expect(row.getByTestId('property-chip')).toHaveText(['K1:v1', 'K2:v2', 'K3:v3'])
    await expect(
      row.getByRole('button', { name: 'Show all 8 properties (Ctrl+Shift+P)', exact: true }),
    ).toHaveText('+5')
  })
})
