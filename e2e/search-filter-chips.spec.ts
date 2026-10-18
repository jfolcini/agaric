/**
 * E2E — Search filter chips re-run the search (#5738): two page-path chips
 * added from *Add filter* OR-combine and scope the results without Enter,
 * removing a chip narrows them, *Clear all* and the zero-results *Clear
 * filters* bring every hit back. In `e2e/` because the mock's `search_blocks`
 * applies the page-path globs, so a chip change that never reaches the search
 * shows here as stale rows.
 */

import type { Page } from '@playwright/test'

import {
  activePopover,
  expect,
  openSearchView,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
} from './helpers'

// `SEED_IDS` in src/lib/tauri-mock/seed.ts.
const PAGE_QUICK_NOTES = '00000000000000000000PAGE02'
const PAGE_PROJECTS = '00000000000000000000PAGE04'
const PAGE_MEETINGS = '00000000000000000000PAGE05'

const TERM = 'quokka'

async function addPagePathChip(page: Page, glob: string): Promise<void> {
  await page.getByRole('button', { name: 'Add filter' }).click()
  const popover = activePopover(page)
  await popover.getByRole('menuitem', { name: /^Page path \(include\)/ }).click()
  await popover.getByRole('textbox', { name: 'Page path (include)' }).fill(glob)
  await popover.getByRole('button', { name: 'Add', exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await openSearchView(page)
})

test('page-path chips scope the results without Enter; remove and Clear all re-run it @search', async ({
  page,
}) => {
  const seeded = await seedSearchBlocks(page, [
    { content: `${TERM} notes`, parentId: PAGE_QUICK_NOTES },
    { content: `${TERM} projects`, parentId: PAGE_PROJECTS },
    { content: `${TERM} meetings`, parentId: PAGE_MEETINGS },
  ])
  const [, projects, meetings] = seeded as [string, string, string]
  const all = seeded.toSorted()
  await submitSearch(page, TERM)
  await expect.poll(() => searchResultIds(page)).toEqual(all)

  await addPagePathChip(page, 'Projects')
  await addPagePathChip(page, 'Meetings')
  await expect.poll(() => searchResultIds(page)).toEqual([projects, meetings].toSorted())

  const chips = page.getByRole('group', { name: 'Filters active' })
  await chips.getByRole('button', { name: 'Remove filter path:Meetings' }).click()
  await expect.poll(() => searchResultIds(page)).toEqual([projects])

  await chips.getByRole('button', { name: 'Clear all' }).click()
  await expect.poll(() => searchResultIds(page)).toEqual(all)
})

test('zero-results Clear filters brings back the matching hits @search', async ({ page }) => {
  const [notes] = await seedSearchBlocks(page, [
    { content: `${TERM} notes`, parentId: PAGE_QUICK_NOTES },
  ])
  await submitSearch(page, `path:Nowhere ${TERM}`)

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect.poll(() => searchResultIds(page)).toEqual([notes])
})
