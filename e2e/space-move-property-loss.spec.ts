import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
  chooseSelectOption,
  expect,
  ipc,
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
 * Personal declares both; Work, the seeded second space
 * (`seedWorkSpace` in `src/lib/tauri-mock/seed.ts`), starts with the defaults
 * only, so moving Meetings there would drop four values. The last test drops
 * a property the target defines with another type, and undoes the move.
 */

const PAGE_MEETINGS = '00000000000000000000PAGE05'

/** The Meetings blocks' property chips, on the page as it is open now. */
const chips = (page: Page) => page.getByTestId('property-chip')

test.beforeEach(async ({ page }) => {
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

test('Cancel from the batch toolbar, worked by Enter, moves nothing and gives focus back to Move @spaces @pages', async ({
  page,
}) => {
  await navigateToView(page, 'Pages')
  await page.getByTestId(`page-select-${PAGE_MEETINGS}`).click()
  const toolbar = page.getByRole('toolbar', { name: '1 selected', exact: true })
  // Enter, not a click: the list behind the toolbar must not open its focused page too.
  await toolbar.getByTestId('page-batch-move-btn').press('Enter')
  await expect(toolbar.getByTestId('page-batch-space-picker')).toBeVisible()
  await chooseSelectOption(page, 'Choose a space…', 'Work')
  const move = toolbar.getByTestId('page-batch-space-confirm')
  await move.press('Enter')

  const dialog = activeAlertDialog(page)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // The preview ran with Move pressed: it must not have dropped the focus the
  // dialog hands back.
  await expect(move).toBeFocused()
  // The selection stands: nothing moved.
  await expect(toolbar).toBeVisible()
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

test('a property defined differently in the target is dropped once confirmed, and one undo moves the page back with it @spaces @editor', async ({
  page,
}) => {
  // `level` is a number in Personal and text in Work, so the move drops the page's 42.
  for (const [spaceId, valueType] of [
    [SEED_IDS.SPACE_PERSONAL, 'number'],
    [SEED_IDS.SPACE_WORK, 'text'],
  ] as const) {
    await ipc(page, 'create_property_def', { spaceId, key: 'level', valueType, options: null })
  }
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Moving page',
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  // A block of its own, so opening the page creates none: the undo reverts the page's newest
  // ops as one group, and the move's must be the newest.
  await ipc(page, 'create_block', {
    blockType: 'content',
    content: 'moving line',
    parentId: pageId,
    index: null,
    scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
    blockId: null,
  })
  await ipc(page, 'set_property', { blockId: pageId, key: 'level', value: { value_num: 42 } })

  await openFromPages(page, 'Moving page')
  await expect(levelOfOpenPage(page)).resolves.toBe('42')
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Work', exact: true }).click()
  const dialog = activeAlertDialog(page)
  await expect(
    dialog.getByRole('list', { name: 'Properties the move removes' }).getByRole('button'),
  ).toHaveText(['level1 value'])
  await dialog.getByRole('button', { name: 'Move and remove', exact: true }).click()
  await expect(page.getByText('Page moved to Work')).toBeVisible()

  // Work: the page and its block came, the value did not.
  await switchToSpace(page, 'Work')
  await openFromPages(page, 'Moving page')
  await expect(page.getByText('moving line', { exact: true })).toBeVisible()
  await expect(page.locator('.page-property-table-header')).toHaveCount(0)

  // Ctrl+Z reaches the page's undo only with no block focused.
  await expect(page.getByTestId('block-editor')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.getByText('Undid property change')).toBeVisible()

  await switchToSpace(page, 'Personal')
  await openFromPages(page, 'Moving page')
  await expect(levelOfOpenPage(page)).resolves.toBe('42')
})

/** Open `title` from the Pages list; the quick-access bar lists it too once it has been opened. */
async function openFromPages(page: Page, title: string): Promise<void> {
  await navigateToView(page, 'Pages')
  await page.locator(`[data-page-title="${title}"]`).click()
  await expect(page.getByLabel('Page title', { exact: true })).toBeVisible()
}

/** The open page's `level`, read from its property table. */
async function levelOfOpenPage(page: Page): Promise<string> {
  await page.locator('.page-property-table-header').click()
  const input = page.getByLabel('level value', { exact: true })
  await expect(input).toBeVisible()
  return input.inputValue()
}
