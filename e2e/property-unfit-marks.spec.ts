import type { Page } from '@playwright/test'

import {
  activeDialog,
  activePopover,
  closePageProperties,
  expect,
  ipc,
  navigateToView,
  openPage,
  openPageProperties,
  openPropertySheet,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6206 — a value that doesn't fit its key wears a mark wherever it shows: on
 * a block's chip and in the page's Properties table, and the mark opens the
 * key's values that don't fit in Settings. The seeded Personal space declares
 * `project` as a select of alpha, beta and gamma, held by the Meetings blocks
 * as alpha and beta; the Meetings page itself is given beta, and dropping beta
 * from the options leaves both betas not fitting.
 *
 * #6545 — beta added back from the page header's Edit options clears the block's mark without
 * leaving the page. The chip reads the space's shared definitions query, which two paths refresh:
 * the header writes the write's answer into it (`updateDefinitions`, #6946), and the change feed's
 * `properties` / `property_defs` domains invalidate it (`invalidatePropertyCaches`). Either alone
 * keeps the test green; it reds only with both broken.
 */

const MEETINGS = '00000000000000000000PAGE05'
const MTG_1 = '0000000000000000000B10CK17'
const MTG_2 = '0000000000000000000B10CK18'
const MARK = "beta doesn't fit Project: review its values"

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await ipc(page, 'set_property', {
    blockId: MEETINGS,
    key: 'project',
    value: { value_text: 'beta' },
  })
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
  await dropBeta(page)
})

function panel(page: Page) {
  return page.getByTestId('settings-panel-properties')
}

/** Drop `beta` from `project`'s options in its property sheet. */
async function dropBeta(page: Page): Promise<void> {
  const editor = await openPropertySheet(page, 'project')
  await editor.getByRole('button', { name: 'Remove option beta', exact: true }).click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(panel(page).getByTestId('property-unfit-project')).toHaveText("2 don't fit")
}

function block(page: Page, id: string) {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
}

/** On Meetings, beta is marked on its block's chip and in the page's Properties table. */
async function expectMarked(page: Page): Promise<void> {
  await openPage(page, 'Meetings')
  await expect(
    block(page, MTG_2).getByRole('group', { name: "Project: beta, doesn't fit" }),
  ).toBeVisible()
  await expect(block(page, MTG_2).getByRole('button', { name: MARK, exact: true })).toBeVisible()
  await expect(
    block(page, MTG_1).getByRole('group', { name: 'Project: alpha', exact: true }),
  ).toBeVisible()
  await expect(block(page, MTG_1).getByRole('button', { name: /doesn't fit/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: MARK, exact: true })).toHaveCount(1)

  const properties = await openPageProperties(page)
  await expect(properties.getByRole('combobox', { name: 'project value', exact: true })).toHaveText(
    'beta',
  )
  // The table's row carries the second mark.
  await expect(properties.getByRole('button', { name: MARK, exact: true })).toHaveCount(1)
  await closePageProperties(page)
}

test.describe("Marks on values that don't fit a property @settings @pages @editor", () => {
  test("a chip and the table row are marked, and the chip's mark opens the review", async ({
    page,
  }) => {
    await expectMarked(page)

    await block(page, MTG_2).getByRole('button', { name: MARK, exact: true }).click()
    const dialog = activeDialog(page)
    await expect(dialog.getByText("Values of project that don't fit")).toBeVisible()
    await expect(dialog.getByText("2 values don't fit.")).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(activeDialog(page)).toHaveCount(0)

    await navigateToView(page, 'Journal')
    await expectMarked(page)
  })

  test("an option added in the page header clears a block's mark without leaving the page (#6545)", async ({
    page,
  }) => {
    await openPage(page, 'Meetings')
    const mark = block(page, MTG_2).getByRole('button', { name: MARK, exact: true })
    await expect(mark).toBeVisible()

    const properties = await openPageProperties(page)
    await properties.getByRole('button', { name: 'Edit options for project', exact: true }).click()
    const editor = activePopover(page)
    await editor.getByRole('textbox', { name: 'New option value', exact: true }).fill('beta')
    await editor.getByRole('button', { name: 'Add option', exact: true }).click()
    await editor.getByRole('button', { name: 'Save options', exact: true }).click()
    await expect(editor).toHaveCount(0)
    // The dialog hides the page from the accessibility tree; close it before reading the block.
    await closePageProperties(page)

    await expect(mark).toHaveCount(0)
  })
})
