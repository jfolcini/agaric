import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
  activeMenu,
  activePopover,
  activeSheet,
  expect,
  navigateToView,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6755, mock lane: a tag names the properties its blocks should have. Added
 * on the tag's page under "Properties for tagged blocks", a key is an empty
 * row "from #work" in the drawer of a block tagged `work`, written once
 * filled; "Set on tagged blocks" sets a value on every block tagged `work`
 * that lacks it, and the toast's Undo takes the whole set back.
 *
 * `work` is on Projects' two blocks and the first Meetings block (attached)
 * and on a Getting Started block (inline); `effort` is a select of the seed's
 * space, held by none of them.
 */

const PROJ_1 = SEED_IDS.BLOCK_PROJ_1

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

/** Open `work`'s page and offer `effort` to its blocks. */
async function offerEffortOnWork(page: Page): Promise<Locator> {
  await navigateToView(page, 'Tags')
  await page.getByTestId('tag-item-work').click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('work')
  const section = page.getByTestId('tag-properties')
  await section.getByRole('button', { name: 'Add property', exact: true }).click()
  await activePopover(page)
    .getByRole('button', { name: /^Effort/ })
    .click()
  await expect(section.getByRole('button', { name: 'Remove effort', exact: true })).toBeVisible()
  return section
}

async function pickOption(page: Page, scope: Locator, key: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: `${key} value`, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

function effortOf(page: Page, blockId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__.invoke
    const rows = (await invoke('get_properties', { blockId: id })) as {
      key: string
      value_text: string | null
    }[]
    return rows.find((r) => r.key === 'effort')?.value_text ?? null
  }, blockId)
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test.describe('A tag names the properties of its blocks @pages @editor', () => {
  test('a key the tag offers is an empty row in a tagged block, kept once filled', async ({
    page,
  }) => {
    await offerEffortOnWork(page)

    await openPage(page, 'Projects')
    let sheet = await openBlockDrawer(page, PROJ_1)
    const suggested = sheet.getByTestId('suggested-property-effort')
    await expect(suggested.getByText('from #work')).toBeVisible()
    await pickOption(page, suggested, 'effort', '1h')
    await expect(sheet.getByTestId('suggested-property-effort')).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()

    await reopenPage(page, 'Projects')
    await expect(blockRow(page, PROJ_1).getByTestId('property-chip')).toContainText(['Effort:1h'])
    sheet = await openBlockDrawer(page, PROJ_1)
    await expect(sheet.getByTestId('suggested-property-effort')).toHaveCount(0)
    await expect(sheet.getByTestId('property-value-input-effort')).toHaveValue('1h')
  })

  test('"Set on tagged blocks" writes every tagged block, and one Undo takes it back', async ({
    page,
  }) => {
    const section = await offerEffortOnWork(page)
    const form = section.getByTestId('set-on-tagged-blocks')
    await pickOption(page, form, 'effort', '2h')
    await form.getByRole('button', { name: 'Set on tagged blocks…', exact: true }).click()

    const dialog = activeAlertDialog(page)
    await expect(dialog.getByText('Blocks that will get it: 4.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Set', exact: true }).click()
    const toast = page.locator('[data-sonner-toast]', { hasText: 'effort set on tagged blocks: 4' })
    await expect(toast).toBeVisible()
    await expect.poll(() => effortOf(page, PROJ_1)).toBe('2h')
    await expect.poll(() => effortOf(page, SEED_IDS.BLOCK_MTG_1)).toBe('2h')

    await toast.getByRole('button', { name: 'Undo', exact: true }).click()
    await reopenPage(page, 'Projects')
    await expect(blockRow(page, PROJ_1)).toBeVisible()
    await expect(blockRow(page, PROJ_1).getByText('Effort:2h')).toHaveCount(0)
    await expect.poll(() => effortOf(page, PROJ_1)).toBeNull()
    await expect.poll(() => effortOf(page, SEED_IDS.BLOCK_MTG_1)).toBeNull()
  })
})
