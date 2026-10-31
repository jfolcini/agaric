import type { Page } from '@playwright/test'

import {
  activeDialog,
  activePopover,
  expect,
  ipc,
  navigateToView,
  openPage,
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
 */

const MEETINGS = '00000000000000000000PAGE05'
const MTG_1 = '0000000000000000000BLOCK17'
const MTG_2 = '0000000000000000000BLOCK18'
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

function projectRow(page: Page) {
  return panel(page)
    .getByRole('listitem')
    .filter({ has: page.getByText('Project', { exact: true }) })
}

/** Drop `beta` from `project`'s options through Edit options. */
async function dropBeta(page: Page): Promise<void> {
  await projectRow(page).getByRole('button', { name: 'Edit options', exact: true }).click()
  const editor = activePopover(page)
  await editor.getByRole('button', { name: 'Remove option beta', exact: true }).click()
  await editor.getByRole('button', { name: 'Save options', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(panel(page).getByTestId('property-unfit-project')).toHaveText("2 don't fit")
}

function block(page: Page, id: string) {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
}

/** Meetings open with its Properties table expanded; beta is marked on its chip and in the table. */
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

  await page.getByRole('button', { name: /^Properties/ }).click()
  await expect(page.getByRole('combobox', { name: 'project value', exact: true })).toHaveText(
    'beta',
  )
  // The table's row carries the second mark.
  await expect(page.getByRole('button', { name: MARK, exact: true })).toHaveCount(2)
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
})
