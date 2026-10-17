/**
 * Advanced Query happy paths (#5738): a nested AND / OR / NOT tree built from
 * filter leaves, and the controls bar's full-text term plus a sort key. Both
 * run the mock's flat `run_advanced_query` path (`handlers/search.ts`), which
 * evaluates the `FilterExpr` tree with the conformance-guarded per-primitive
 * matrix, intersects the full-text term and honours the sort keys, so a
 * builder or controls regression shows up as a wrong result list here.
 *
 * Seed ids pointer: `SEED_IDS` in `src/lib/tauri-mock/seed.ts`.
 */
import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  chooseSelectOption,
  expect,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

const TAG_WORK = '000000000000000000000TAG01'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

/** Open the "Add filter" popover owned by `group` and pick the facet named `facet`. */
async function openFacet(page: Page, group: Locator, facet: RegExp): Promise<Locator> {
  await group.getByRole('button', { name: 'Add filter', exact: true }).click()
  const pop = activePopover(page)
  await pop.getByRole('button', { name: facet }).click()
  return pop
}

async function addTagLeaf(page: Page, group: Locator, tag: string): Promise<void> {
  const pop = await openFacet(page, group, /^Tag/)
  await pop.getByRole('button', { name: tag, exact: true }).click()
  await expect(group.getByRole('group', { name: `tag: ${tag}`, exact: true })).toBeVisible()
}

function resultRows(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Query results' }).getByRole('option')
}

test('a nested AND / OR / NOT tree returns exactly the blocks it selects', async ({ page }) => {
  // Tagged `work` but DONE: only the NOT leaf can drop it.
  await seedSearchBlocks(page, [
    { content: 'Archived work task', todo: 'DONE', tagIds: [TAG_WORK] },
  ])
  await navigateToView(page, 'Advanced Query')

  // The empty builder matches the whole space, so both blocks the tree must
  // drop are in the result set before it is built.
  await expect(resultRows(page).filter({ hasText: 'Archived work task' })).toHaveCount(1)
  await expect(resultRows(page).filter({ hasText: 'Review pull requests' })).toHaveCount(1)

  const root = page.getByRole('group', { name: 'Filter', exact: true })
  const statePop = await openFacet(page, root, /^State/)
  await statePop.getByRole('checkbox', { name: 'DONE', exact: true }).click()
  await statePop.getByRole('button', { name: 'Apply', exact: true }).click()
  const stateLeaf = root
    .getByTestId('filter-group-leaf')
    .filter({ has: page.getByRole('group', { name: 'state: DONE', exact: true }) })
  await stateLeaf.getByRole('button', { name: 'NOT', exact: true }).click()
  await expect(stateLeaf.getByRole('button', { name: 'NOT', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await root.getByRole('button', { name: 'Add group', exact: true }).click()
  const anyGroup = root.getByRole('group', { name: 'Filter group', exact: true })
  await anyGroup.getByRole('radio', { name: 'Any', exact: true }).click()
  await addTagLeaf(page, anyGroup, 'work')
  await addTagLeaf(page, anyGroup, 'personal')

  // (tag work OR tag personal) AND NOT state DONE, newest block id first.
  // "Review pull requests" (untagged) fails the OR group; "Archived work task"
  // (work, DONE) fails the NOT leaf.
  await expect(resultRows(page)).toHaveText([
    /Weekly standup notes/,
    /Fix login bug/,
    /Ship v2\.0 release/,
    /Buy groceries/,
  ])
})

test('a full-text term narrows the results and a sort key orders them', async ({ page }) => {
  // The sort picker offers no due-date column (`SORT_COLUMNS` in
  // QueryControlsBar.tsx), so priority is the order under test. Equal-length
  // texts tie on relevance, so neither the unsorted order (id descending) nor
  // creation order matches priority order.
  await seedSearchBlocks(page, [
    { content: 'Quokka one', priority: '2' },
    { content: 'Quokka two', priority: '1' },
    { content: 'Quokka six', priority: '3' },
  ])
  await navigateToView(page, 'Advanced Query')

  await page.getByRole('searchbox', { name: 'Full-text search' }).fill('quokka')
  await expect(page.getByTestId('advanced-query-total')).toHaveText('3 matching blocks')

  await page.getByRole('button', { name: 'Add sort key', exact: true }).click()
  await chooseSelectOption(page, 'Sort field', 'Priority')

  await expect(resultRows(page)).toHaveText([/Quokka two/, /Quokka one/, /Quokka six/])
})
