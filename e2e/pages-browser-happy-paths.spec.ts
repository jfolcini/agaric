import type { Locator, Page } from '@playwright/test'

import {
  activeAlertDialog,
  activeDialog,
  activePopover,
  clearConsoleErrors,
  createPageFromPagesView,
  expect,
  getConsoleErrors,
  navigateToView,
  openAddFilter,
  test,
  waitForBoot,
} from './helpers'

/**
 * Pages browser happy paths (#5738): creating a page from a namespace
 * folder's `+`, multi-select batch Trash, saved views, and a header rename
 * refused for a taken title. Each is one view's state over IPC calls the mock
 * models, so it is shown failing here, in `e2e/`.
 *
 * The default "Exclude journal pages" chip (#5370) stays on, so the seed lists
 * five pages: Getting Started, Meeting Notes Template, Meetings, Projects,
 * Quick Notes.
 */

// `SEED_IDS` in `src/lib/tauri-mock/seed.ts`.
const PAGE_PROJECTS = '00000000000000000000PAGE04'
const PAGE_MEETINGS = '00000000000000000000PAGE05'
const PAGE_TMPL_MEETING = '00000000000000000000PAGE06'

const grid = (page: Page): Locator => page.getByRole('grid')

const flatPageTitles = (page: Page): Locator =>
  grid(page).locator('[data-page-item] .page-browser-item-title')

async function openPagesView(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await expect(grid(page)).toBeVisible()
}

async function selectSort(page: Page, option: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Sort order' }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await openPagesView(page)
})

test('the + on a namespace folder creates a page inside it through the New page dialog', async ({
  page,
}) => {
  // The seed has no namespaced page, so make the `Work` folder first.
  await createPageFromPagesView(page, 'Work/Alpha')
  await openPagesView(page)

  await page.getByRole('button', { name: 'Create page under Work', exact: true }).click()
  const dialog = activeDialog(page)
  const input = dialog.getByRole('textbox', { name: 'New page title' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Work/')
  await expect(dialog.getByTestId('new-page-parent-path')).toHaveText('Inside Work')

  await input.press('End')
  await input.pressSequentially('Beta')
  await input.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Work/Beta')

  await openPagesView(page)
  const folder = page.locator('[data-page-tree-row]').filter({
    has: page.getByRole('button', { name: 'Toggle Work namespace', exact: true }),
  })
  await expect(folder.locator('span[title^="Work/"]')).toHaveText(['Alpha', 'Beta'])
})

test('Ctrl+Click and Shift+Click select three pages, and batch Trash moves them to Trash', async ({
  page,
}) => {
  await expect(flatPageTitles(page)).toHaveText([
    'Getting Started',
    'Meeting Notes Template',
    'Meetings',
    'Projects',
    'Quick Notes',
  ])

  await page.getByTestId(`page-select-${PAGE_TMPL_MEETING}`).click({ modifiers: ['ControlOrMeta'] })
  await page.getByTestId(`page-select-${PAGE_PROJECTS}`).click({ modifiers: ['Shift'] })
  const toolbar = page.getByRole('toolbar', { name: '3 selected', exact: true })
  await expect(toolbar).toBeVisible()
  // Never clicked: the Shift range swept it in.
  await expect(page.getByTestId(`page-select-${PAGE_MEETINGS}`)).toBeChecked()

  await toolbar.getByRole('button', { name: 'Trash', exact: true }).click()
  const confirm = activeAlertDialog(page)
  await expect(confirm.getByText('Move 3 pages to Trash?', { exact: true })).toBeVisible()
  await confirm.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(flatPageTitles(page)).toHaveText(['Getting Started', 'Quick Notes'])

  await navigateToView(page, 'Trash')
  await expect(page.getByTestId('trash-item')).toHaveCount(3)
  for (const id of [PAGE_TMPL_MEETING, PAGE_MEETINGS, PAGE_PROJECTS]) {
    await expect(page.locator(`#trash-item-${id}`)).toBeVisible()
  }

  await openPagesView(page)
  await expect(flatPageTitles(page)).toHaveText(['Getting Started', 'Quick Notes'])
})

test('a saved view restores its sort and filter chips', async ({ page }) => {
  const sort = page.getByRole('combobox', { name: 'Sort order' })
  const orphanChip = page.getByRole('group', { name: 'Filter: Orphan', exact: true })
  const journalChip = page.getByRole('group', { name: 'Filter: Exclude journal pages' })
  const savedViews = page.getByTestId('saved-views-trigger')
  // Orphans outside the journal, most child blocks first (`compareMetaRows`).
  const viewRows = ['Projects', 'Meeting Notes Template', 'Meetings']

  await selectSort(page, 'Most content')
  await openAddFilter(page)
  await activePopover(page)
    .getByRole('button', { name: /^Orphan/ })
    .click()
  await expect(orphanChip).toBeVisible()
  await expect(flatPageTitles(page)).toHaveText(viewRows)

  await savedViews.click()
  await activePopover(page).getByRole('button', { name: 'Save current view…' }).click()
  const dialog = activeDialog(page)
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Orphans by size')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(savedViews).toHaveAccessibleName('Saved views — Orphans by size applied')

  await page.getByRole('button', { name: 'Clear all filters' }).click()
  await selectSort(page, 'Alphabetical')
  await expect(journalChip).toHaveCount(0)
  await expect(flatPageTitles(page)).toHaveCount(6)
  await expect(savedViews).toHaveAccessibleName('Saved views')

  await navigateToView(page, 'Journal')
  await openPagesView(page)
  await savedViews.click()
  await activePopover(page).getByRole('button', { name: 'Apply view Orphans by size' }).click()

  await expect(sort).toHaveText('Most content')
  await expect(orphanChip).toBeVisible()
  await expect(journalChip).toBeVisible()
  await expect(flatPageTitles(page)).toHaveText(viewRows)
  await expect(savedViews).toHaveAccessibleName('Saved views — Orphans by size applied')
})

// A rename onto a free title is covered by `rename-invalidation.spec.ts` (#5250).
test('renaming a page in its header onto an existing title is refused and keeps the old title', async ({
  page,
}) => {
  const title = page.locator('[aria-label="Page title"]')
  await grid(page).getByText('Projects', { exact: true }).click()
  await expect(title).toHaveText('Projects')

  await title.fill('Meetings')
  await title.press('Enter')
  await expect(
    page
      .locator('[data-sonner-toast]')
      .getByText('A page with this title already exists in this space', { exact: true }),
  ).toBeVisible()
  await expect(title).toHaveText('Projects')
  // The refusal is logged on purpose.
  await expect
    .poll(() => getConsoleErrors(page))
    .toEqual([expect.stringContaining('Failed to rename page')])
  clearConsoleErrors(page)

  await openPagesView(page)
  await expect(flatPageTitles(page)).toHaveText([
    'Getting Started',
    'Meeting Notes Template',
    'Meetings',
    'Projects',
    'Quick Notes',
  ])
  await grid(page).getByText('Projects', { exact: true }).click()
  await expect(title).toHaveText('Projects')
})
