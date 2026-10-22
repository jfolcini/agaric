import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  chooseSelectOption,
  expect,
  navigateToView,
  openPage,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

/**
 * Move to space confirms the properties it drops (#5841 S0.6), from the Pages
 * batch toolbar and from the page header.
 *
 * The seed's Meetings page holds `context` and `project` on its two blocks.
 * Personal declares both; Work, the mock's opt-in second space
 * (`seedWorkSpace` in `src/lib/tauri-mock/seed.ts`), starts with the defaults
 * only, so moving Meetings there would drop four values. The real-backend
 * lane carries the drop and its undo (`e2e-tauri/space-move-property-loss.e2e.ts`);
 * this lane carries the batch path, the listing of the blocks that hold the
 * values, and the dialog's focus on cancel.
 */

const PAGE_MEETINGS = '00000000000000000000PAGE05'

/** The Meetings blocks' property chips, on the page as it is open now. */
const chips = (page: Page) => page.getByTestId('property-chip')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockWorkSpace', 'true'))
  await waitForBoot(page)
})

test('a batch move lists the properties it drops and their blocks, and drops them once confirmed @spaces @pages', async ({
  page,
}) => {
  await navigateToView(page, 'Pages')
  await page.getByTestId(`page-select-${PAGE_MEETINGS}`).click()
  const toolbar = page.getByRole('toolbar', { name: '1 selected', exact: true })
  await toolbar.getByTestId('page-batch-move-btn').click()
  await chooseSelectOption(page, 'Choose a space…', 'Work')
  await toolbar.getByTestId('page-batch-space-confirm').click()

  const dialog = activeAlertDialog(page)
  await expect(dialog.getByRole('heading')).toHaveText('Move and remove properties?')
  const losses = dialog.getByRole('list', { name: 'Properties the move removes' })
  await expect(losses.getByRole('button')).toHaveText(['context2 values', 'project2 values'])

  const project = losses.getByRole('button', { name: /^project/ })
  await project.click()
  const holders = page.locator(`[id="${await project.getAttribute('aria-controls')}"]`)
  await expect(holders.getByRole('listitem')).toHaveText([
    'Meetings › Weekly standup notesalpha',
    'Meetings › Design review feedbackbeta',
  ])

  await dialog.getByRole('button', { name: 'Move and remove', exact: true }).click()
  await expect(page.getByText('Moved 1 page', { exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // Work: the page came, without the values Work does not declare.
  await switchToSpace(page, 'Work')
  await openPage(page, 'Meetings')
  await expect(page.getByText('Weekly standup notes', { exact: true })).toBeVisible()
  await expect(chips(page)).toHaveCount(0)
})

test('the page header asks the same, and Cancel leaves the page where it was @spaces @editor', async ({
  page,
}) => {
  await openPage(page, 'Meetings')
  await expect(chips(page).filter({ hasText: 'alpha' })).toBeVisible()
  const kebab = page.getByRole('button', { name: 'Page actions', exact: true })
  await kebab.click()
  await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Work', exact: true }).click()

  const dialog = activeAlertDialog(page)
  await expect(
    dialog.getByRole('list', { name: 'Properties the move removes' }).getByRole('button'),
  ).toHaveText(['context2 values', 'project2 values'])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(kebab).toBeFocused()

  // Still in Personal, values and all: leave the page and come back.
  await navigateToView(page, 'Journal')
  await openPage(page, 'Meetings')
  await expect(chips(page).filter({ hasText: 'alpha' })).toBeVisible()
  await expect(chips(page).filter({ hasText: '@office' })).toBeVisible()
})
