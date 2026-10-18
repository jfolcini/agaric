/**
 * Advanced Query saved views (#5738): a saved query is listed after leaving
 * the view and coming back, Load restores its tree and results, rename and
 * delete stick, and another space does not list it. Views live in the
 * frontend's per-space preference, not in the backend, so the mock lane shows
 * every one of these failing.
 *
 * Seed ids pointer: `SEED_IDS` in `src/lib/tauri-mock/seed.ts`; the opt-in
 * second space "Work" is `seedWorkSpace` there.
 */
import type { Locator, Page } from '@playwright/test'

import { activePopover, expect, navigateToView, switchToSpace, test, waitForBoot } from './helpers'

const VIEW = 'Work blocks'
const RENAMED = 'Work items'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockWorkSpace', 'true'))
  await waitForBoot(page)
})

function resultRows(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Query results' }).getByRole('option')
}

function savedViews(page: Page): Locator {
  return page.getByRole('region', { name: 'Saved views', exact: true })
}

function tagLeaf(page: Page): Locator {
  return page
    .getByRole('group', { name: 'Filter', exact: true })
    .getByRole('group', { name: 'tag: work', exact: true })
}

/** Leave Advanced Query for the journal and open it again. */
async function reopenAdvancedQuery(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Advanced Query')
}

/** The tag `work` leaf keeps exactly the three seeded blocks tagged `work`. */
const WORK_ROWS = [/Weekly standup notes/, /Fix login bug/, /Ship v2\.0 release/]

test('a saved view is listed after leaving, loads, renames, deletes, and stays in its space', async ({
  page,
}) => {
  await navigateToView(page, 'Advanced Query')
  const root = page.getByRole('group', { name: 'Filter', exact: true })
  await root.getByRole('button', { name: 'Add filter', exact: true }).click()
  const pop = activePopover(page)
  await pop.getByRole('button', { name: /^Tag/ }).click()
  await pop.getByRole('button', { name: 'work', exact: true }).click()
  await expect(tagLeaf(page)).toBeVisible()
  await expect(resultRows(page)).toHaveText(WORK_ROWS)

  await page.getByRole('button', { name: 'Save the current query as a named view' }).click()
  const saveDialog = page.getByRole('dialog')
  await saveDialog.getByRole('textbox').fill(VIEW)
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()

  // Clear the builder so only Load can bring the leaf back.
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(tagLeaf(page)).toHaveCount(0)

  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(VIEW)])
  await expect(tagLeaf(page)).toHaveCount(0)
  await savedViews(page)
    .getByRole('button', { name: `Load "${VIEW}"` })
    .click()
  await expect(tagLeaf(page)).toBeVisible()
  await expect(resultRows(page)).toHaveText(WORK_ROWS)

  await savedViews(page)
    .getByRole('button', { name: `Rename "${VIEW}"` })
    .click()
  const renameDialog = page.getByRole('dialog')
  await renameDialog.getByRole('textbox').fill(RENAMED)
  await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(RENAMED)])

  await switchToSpace(page, 'Work')
  await navigateToView(page, 'Advanced Query')
  await expect(savedViews(page).getByText('No saved views yet')).toBeVisible()
  await switchToSpace(page, 'Personal')
  await navigateToView(page, 'Advanced Query')
  await expect(savedViews(page).getByTestId('saved-view-row')).toHaveText([new RegExp(RENAMED)])

  await savedViews(page)
    .getByRole('button', { name: `Delete "${RENAMED}"` })
    .click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await reopenAdvancedQuery(page)
  await expect(savedViews(page).getByText('No saved views yet')).toBeVisible()
})
