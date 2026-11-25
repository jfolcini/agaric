import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeDialog,
  expect,
  ipc,
  navigateToView,
  openPage,
  openPropertySheet,
  openSettingsTab,
  reopenPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5841 S3 — Settings › Properties changes a key's type on every block of the
 * space that holds it. The seeded Personal space declares `context` as text,
 * held by two meeting blocks as `@office` and `@remote`, neither a number nor
 * a date. A value the new type can't hold is kept as text (#6206). The change
 * is read back after leaving the view and coming back: the type from the list,
 * the values from `get_properties`.
 */

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

async function openProperties(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
}

/** Open `context`'s type dialog and pick `type`. */
async function pickContextType(page: Page, type: string) {
  await openProperties(page)
  await (
    await openPropertySheet(page, 'context')
  )
    .getByRole('button', { name: 'Change type…' })
    .click()
  const dialog = activeDialog(page)
  await dialog.getByRole('combobox', { name: 'New type' }).click()
  await page.getByRole('option', { name: type, exact: true }).click()
  return dialog
}

function panel(page: Page) {
  return page.locator('[data-testid="settings-panel-properties"]')
}

const MEETINGS = '00000000000000000000PAGE05'

function contextRow(page: Page) {
  return panel(page).locator('ul > li', { hasText: 'Context' })
}

/** Change `context` to number, past the dialog that lists the two values that don't fit. */
async function changeToNumber(page: Page): Promise<void> {
  const dialog = await pickContextType(page, 'number')
  await expect(dialog.getByRole('tab', { name: "Don't fit (2)" })).toBeVisible()
  await expect(dialog.getByRole('tabpanel').getByRole('listitem')).toHaveCount(2)
  await expect(dialog.getByRole('tabpanel')).toContainText('@office')
  await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
  await expect(activeDialog(page)).toHaveCount(0)
}

test.describe('Change a property type @settings', () => {
  test('a change to number keeps the values that are not numbers', async ({ page }) => {
    await changeToNumber(page)

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(contextRow(page).getByText('number', { exact: true })).toBeVisible()
    await expect(panel(page).getByTestId('property-usage-context')).toHaveText('2 uses')
  })

  test('a change to date keeps a value that is not a date on its block, as text', async ({
    page,
  }) => {
    await seedSearchBlocks(page, [
      { content: 'Retype holder', parentId: MEETINGS, props: { context: 'soon' } },
    ])
    const dialog = await pickContextType(page, 'date')
    await expect(dialog.getByRole('tab', { name: "Don't fit (3)", selected: true })).toBeVisible()
    const holder = dialog
      .getByRole('tabpanel')
      .getByRole('listitem')
      .filter({ hasText: 'Retype holder' })
    await expect(holder).toContainText('soon')
    await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
    await expect(activeDialog(page)).toHaveCount(0)

    await openPage(page, 'Meetings')
    const chips = page
      .locator('[data-testid="sortable-block"]', { hasText: 'Retype holder' })
      .locator('[data-testid="property-chip"]')
    await expect(chips).toHaveText(['Context:soon'])
    await reopenPage(page, 'Meetings')
    await expect(chips).toHaveText(['Context:soon'])
  })

  test("the toast's Undo brings the type and the values back", async ({ page }) => {
    await changeToNumber(page)
    await page
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole('button', { name: 'Undo', exact: true })
      .click()

    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(contextRow(page).getByText('text', { exact: true })).toBeVisible()
    await expect(panel(page).getByTestId('property-usage-context')).toHaveText('2 uses')
  })
})

interface HeldRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_list: Array<string | number | null> | null
}

/** The row of `key` that `blockId` holds, as the backend stores it. */
async function held(page: Page, blockId: string, key: string): Promise<HeldRow | undefined> {
  const rows = await ipc<HeldRow[]>(page, 'get_properties', { blockId })
  return rows.find((row) => row.key === key)
}

async function declareText(page: Page, key: string): Promise<void> {
  await ipc(page, 'create_property_def', {
    spaceId: SEED_IDS.SPACE_PERSONAL,
    key,
    valueType: 'text',
    options: null,
    multiple: null,
  })
}

function keyRow(page: Page, key: string) {
  return panel(page).locator('ul > li', { hasText: key })
}

test.describe('Change a property type, value by value @settings @editor', () => {
  test('converts the value that fits and keeps the other as text', async ({ page }) => {
    await declareText(page, 'points')
    const [fits, unfit] = await seedSearchBlocks(page, [
      { content: 'Points three', parentId: MEETINGS, props: { points: '3' } },
      { content: 'Points plum', parentId: MEETINGS, props: { points: 'plum' } },
    ])
    await openProperties(page)
    await (
      await openPropertySheet(page, 'points')
    )
      .getByRole('button', { name: 'Change type…' })
      .click()
    const dialog = activeDialog(page)
    await dialog.getByRole('combobox', { name: 'New type' }).click()
    await page.getByRole('option', { name: 'number', exact: true }).click()
    await expect(dialog).toContainText('1 value is converted.')
    await expect(dialog).toContainText("1 value isn't a number")
    await expect(dialog.getByRole('tabpanel').getByRole('listitem')).toHaveText([/plum/])
    await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
    await expect(page.getByText('Changed points to number')).toBeVisible()

    expect(await held(page, fits as string, 'points')).toMatchObject({
      value_num: 3,
      value_text: null,
    })
    expect(await held(page, unfit as string, 'points')).toMatchObject({ value_text: 'plum' })
    await openPage(page, 'Meetings')
    const chip = (label: string) =>
      page.locator(`[data-testid="property-chip"][aria-label="${label}"]`)
    await expect(chip('Points: 3')).toBeVisible()
    await expect(chip("Points: plum, doesn't fit")).toBeVisible()
  })

  test('splits a comma-joined text into a list, and the toast’s Undo brings the text back (#6741)', async ({
    page,
  }) => {
    await declareText(page, 'authors')
    const [holder] = await seedSearchBlocks(page, [
      { content: 'Authors holder', parentId: MEETINGS, props: { authors: 'Ann, Bob' } },
    ])
    await openProperties(page)
    await (
      await openPropertySheet(page, 'authors')
    )
      .getByRole('button', { name: 'Change type…' })
      .click()
    const dialog = activeDialog(page)
    await dialog.getByRole('checkbox', { name: 'Holds several values' }).click()
    await dialog.getByRole('radio', { name: /Split at commas/ }).click()
    await expect(dialog).toContainText('1 value is converted.')
    await dialog.getByRole('button', { name: 'Change type', exact: true }).click()
    const toast = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Changed authors to text · several values' })
    await expect(toast).toBeVisible()
    expect(await held(page, holder as string, 'authors')).toMatchObject({
      value_list: ['Ann', 'Bob'],
      value_text: null,
    })

    await toast.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect
      .poll(async () => {
        const row = await held(page, holder as string, 'authors')
        return [row?.value_text, row?.value_list ?? null]
      })
      .toEqual(['Ann, Bob', null])
    await navigateToView(page, 'Journal')
    await openProperties(page)
    await expect(keyRow(page, 'authors')).toContainText('text')
    await expect(keyRow(page, 'authors')).not.toContainText('several values')
  })
})
