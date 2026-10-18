/**
 * The References panel's filters: the builder's Status, Priority, Has Tag and
 * Property, and the source-page popover's include and exclude.
 *
 * A task's state and priority live in their `blocks` columns, so the builder
 * must send `TodoState` / `Priority`; a property filter on `todo` / `priority`
 * matches nothing ("Showing 0 of 5"). The builder's Clear all drops its own
 * filters only; the popover's exclude survives until the popover's Clear all.
 * Here because the mock shows each failure; its filter evaluation is pinned to
 * the backend by `conformance/fixtures/query_backlinks_grouped_filters.json`.
 */

import type { Locator, Page } from '@playwright/test'

import {
  activePopover,
  chooseSelectOption,
  expect,
  openPage,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

// `SEED_IDS` in src/lib/tauri-mock/seed.ts. Quick Notes' seeded block already
// links to Getting Started, so the panel lists five references.
const GETTING_STARTED = '00000000000000000000PAGE01'
const MEETINGS = '00000000000000000000PAGE05'
const TAG_WORK = '000000000000000000000TAG01'

/** Tasks on Projects (A, B, C) and Meetings (D), each linking to Getting Started. */
async function seedTasks(page: Page): Promise<void> {
  const link = `[[${GETTING_STARTED}]]`
  await seedSearchBlocks(page, [
    { content: `Filter task A on ${link}`, todo: 'TODO', priority: '1' },
    { content: `Filter task B on ${link}`, todo: 'TODO', priority: '2' },
    { content: `Filter task C on ${link}`, todo: 'DONE', priority: '1' },
    { content: `Filter task D on ${link}`, todo: 'TODO', priority: '1', parentId: MEETINGS },
  ])
}

async function addFilter(page: Page, references: Locator, category: string, value: string) {
  await references.getByRole('button', { name: 'Add filter', exact: true }).click()
  await chooseSelectOption(page, 'Filter category', category)
  await chooseSelectOption(page, `${category} value`, value)
  await references.getByRole('button', { name: 'Apply filter' }).click()
}

test.describe('References filters', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedTasks(page)
  })

  test('Status, Priority and a source-page exclude narrow the references', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const references = page.getByTestId('linked-references')
    // Groups sort by page title: Meetings, Projects, Quick Notes.
    const rows = references.getByText(/Filter task [A-D]|complement the/)
    const showing = references.getByText(/^Showing \d+ of \d+ backlinks$/)
    await expect(rows).toHaveText([/task D/, /task A/, /task B/, /task C/, /complement/])

    await addFilter(page, references, 'Status', 'TODO')
    await expect(rows).toHaveText([/task D/, /task A/, /task B/])
    await expect(showing).toHaveText('Showing 3 of 5 backlinks')

    await references.getByRole('button', { name: 'Filter by source page' }).click()
    await activePopover(page)
      .getByRole('button', { name: /^Meetings/ })
      .click({ modifiers: ['Shift'] })
    await page.keyboard.press('Escape')
    await expect(rows).toHaveText([/task A/, /task B/])
    await expect(showing).toHaveText('Showing 2 of 5 backlinks')

    await addFilter(page, references, 'Priority', 'High [1]')
    await expect(rows).toHaveText([/task A/])
    await expect(showing).toHaveText('Showing 1 of 5 backlinks')

    // The builder's Clear all leaves the popover's exclude in place.
    await references.getByRole('button', { name: 'Clear all filters and sort' }).click()
    await expect(rows).toHaveText([/task A/, /task B/, /task C/, /complement/])
    await expect(showing).toHaveCount(0)

    await references.getByRole('button', { name: 'Filter by source page' }).click()
    await activePopover(page).getByRole('button', { name: 'Clear all' }).click()
    await expect(rows).toHaveText([/task D/, /task A/, /task B/, /task C/, /complement/])
  })

  test('a source-page include keeps only that page, until the popover clears it', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const references = page.getByTestId('linked-references')
    const rows = references.getByText(/Filter task [A-D]|complement the/)
    await expect(rows).toHaveText([/task D/, /task A/, /task B/, /task C/, /complement/])

    await references.getByRole('button', { name: 'Filter by source page' }).click()
    await activePopover(page)
      .getByRole('button', { name: /^Projects/ })
      .click()
    await page.keyboard.press('Escape')
    await expect(rows).toHaveText([/task A/, /task B/, /task C/])

    await references.getByRole('button', { name: 'Filter by source page' }).click()
    await activePopover(page).getByRole('button', { name: 'Clear all' }).click()
    await expect(rows).toHaveText([/task D/, /task A/, /task B/, /task C/, /complement/])
  })
})

test.describe('References tag and property filters', () => {
  test('Has Tag and a Property filter narrow the references, each on its own', async ({ page }) => {
    await waitForBoot(page)
    const link = `[[${GETTING_STARTED}]]`
    await seedSearchBlocks(page, [
      { content: `Tagged E on ${link}`, tagIds: [TAG_WORK], props: { context: 'office' } },
      { content: `Tagged F on ${link}`, tagIds: [TAG_WORK] },
      { content: `Untagged G on ${link}`, props: { context: 'office' } },
    ])
    await openPage(page, 'Getting Started')
    const references = page.getByTestId('linked-references')
    const rows = references.getByText(/(Tagged|Untagged) [E-G] on|complement the/)
    const showing = references.getByText(/^Showing \d+ of \d+ backlinks$/)
    await expect(rows).toHaveText([/E on/, /F on/, /G on/, /complement/])
    // A block in edit mode would take the first click on Add filter.
    await expect(page.getByTestId('block-editor')).toHaveCount(0)

    await references.getByRole('button', { name: 'Add filter', exact: true }).click()
    await chooseSelectOption(page, 'Filter category', 'Has Tag')
    await references.getByTestId('tag-search-popover').click()
    await activePopover(page).getByRole('option', { name: 'work', exact: true }).click()
    await expect(references.getByTestId('tag-search-popover')).toHaveText('work')
    await references.getByRole('button', { name: 'Apply filter' }).click()
    await expect(rows).toHaveText([/E on/, /F on/])
    await expect(showing).toHaveText('Showing 2 of 4 backlinks')

    await references.getByRole('button', { name: 'Add filter', exact: true }).click()
    await chooseSelectOption(page, 'Filter category', 'Property')
    await chooseSelectOption(page, 'Property key', 'context')
    await references.getByRole('textbox', { name: 'Property value' }).fill('office')
    await references.getByRole('button', { name: 'Apply filter' }).click()
    await expect(rows).toHaveText([/E on/])
    await expect(showing).toHaveText('Showing 1 of 4 backlinks')

    // Without the tag pill the property filter alone admits G.
    await references.getByRole('button', { name: /^Remove filter has tag/ }).click()
    await expect(rows).toHaveText([/E on/, /G on/])
    await expect(showing).toHaveText('Showing 2 of 4 backlinks')
  })
})
