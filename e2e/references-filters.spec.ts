/**
 * The References panel's filters: the builder's Status, Priority, Has tag and
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

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activePopover,
  chooseSelectOption,
  expect,
  ipc,
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

test.describe('References filters @pages @search', () => {
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

test.describe('References tag and property filters @pages @search', () => {
  test('Has tag and a Property filter narrow the references, each on its own', async ({ page }) => {
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
    await chooseSelectOption(page, 'Filter category', 'Has tag')
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

/**
 * Status and Priority `none`, and a Contains term under three characters. `none` is
 * `Not(Or(<every state or level>))`, which the backend compiles as `NOT COALESCE((inner), 0)` so a
 * NULL column joins the complement; Contains reads the FTS index, which dropped a term under three
 * characters until #6752.
 */
test.describe('References none and short Contains filters (#5736) @pages @search', () => {
  // `+1` is a two-character term no other word here contains.
  const SOURCES = {
    todoHigh: { content: 'Ref todo-high +1', todo: 'TODO', priority: '1' },
    todoMedium: { content: 'Ref todo-medium', todo: 'TODO', priority: '2' },
    doneHigh: { content: 'Ref done-high', todo: 'DONE', priority: '1' },
    // A state but no priority, so Status none and Priority none differ.
    todoBare: { content: 'Ref todo-bare', todo: 'TODO' },
    plain: { content: 'Ref plain +1' },
  }
  type Source = keyof typeof SOURCES

  test('none and a two-character Contains list exactly the sources they select', async ({
    page,
  }) => {
    await waitForBoot(page)
    const target = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Ref target',
      spaceId: SEED_IDS.SPACE_PERSONAL,
    })
    await seedSearchBlocks(
      page,
      Object.values(SOURCES).map((s) =>
        Object.assign({}, s, { content: `${s.content} [[${target}]]` }),
      ),
    )
    await openPage(page, 'Ref target')
    const references = page.getByTestId('linked-references')
    const rows = references.locator('li[data-backlink-item] .linked-reference-item-text')
    const showing = references.getByText(/^Showing \d+ of \d+ backlinks$/)
    // Each filter is added only once Clear all has settled: an Add filter opened before that
    // closes again under it.
    const clearFilters = async () => {
      await references.getByRole('button', { name: 'Clear all filters and sort' }).click()
      await expect(showing).toHaveCount(0)
      await expect(rows).toHaveCount(5)
    }
    const expectListed = async (sources: Source[], count: string) => {
      await expect(showing).toHaveText(count)
      await expect(rows).toHaveText(
        sources.map((s) => new RegExp(SOURCES[s].content.replace('+', '\\+'))),
      )
    }
    await expect(rows).toHaveCount(5)

    await addFilter(page, references, 'Status', 'None')
    await expectListed(['plain'], 'Showing 1 of 5 backlinks')
    await clearFilters()
    await addFilter(page, references, 'Priority', 'None')
    await expectListed(['todoBare', 'plain'], 'Showing 2 of 5 backlinks')
    await clearFilters()

    const addContains = async (text: string) => {
      await references.getByRole('button', { name: 'Add filter', exact: true }).click()
      await chooseSelectOption(page, 'Filter category', 'Contains')
      await references.getByLabel('Contains text').fill(text)
      await references.getByRole('button', { name: 'Apply filter' }).click()
    }
    await addContains('+1')
    await expectListed(['todoHigh', 'plain'], 'Showing 2 of 5 backlinks')
    await clearFilters()
    await addContains('+1 todo')
    await expectListed(['todoHigh'], 'Showing 1 of 5 backlinks')
  })
})

/**
 * Created date sends `CreatedInRange`, which the backend compares against the time in each
 * block's ULID, a bound being that day's UTC midnight. The mock's ids carry no time, so only the
 * real backend runs this.
 */
test.describe('References Created date filter (#5736) @pages @search @real-only', () => {
  /** `YYYY-MM-DD` of the UTC day `days` from now: two either side brackets every block made now. */
  function utcDay(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  }

  test('lists the sources created inside a Created date range and none outside it', async ({
    page,
  }) => {
    await waitForBoot(page)
    const target = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Created target',
      spaceId: SEED_IDS.SPACE_PERSONAL,
    })
    await seedSearchBlocks(
      page,
      ['one', 'two', 'three'].map((n) => ({ content: `Created ${n} [[${target}]]` })),
    )
    await openPage(page, 'Created target')
    const references = page.getByTestId('linked-references')
    const rows = references.locator('li[data-backlink-item] .linked-reference-item-text')
    const showing = references.getByText(/^Showing \d+ of \d+ backlinks$/)
    await expect(rows).toHaveCount(3)

    const addCreated = async (after: string | null, before: string | null) => {
      await references.getByRole('button', { name: 'Add filter', exact: true }).click()
      await chooseSelectOption(page, 'Filter category', 'Created date')
      if (after !== null) await references.getByLabel('Date after').fill(after)
      if (before !== null) await references.getByLabel('Date before').fill(before)
      await references.getByRole('button', { name: 'Apply filter' }).click()
    }
    const clearFilters = async () => {
      await references.getByRole('button', { name: 'Clear all filters and sort' }).click()
      await expect(showing).toHaveCount(0)
      await expect(rows).toHaveCount(3)
    }

    await addCreated(utcDay(-2), utcDay(2))
    await expect(showing).toHaveText('Showing 3 of 3 backlinks')
    await expect(rows).toHaveCount(3)
    await clearFilters()
    await addCreated(null, utcDay(-2))
    await expect(showing).toHaveText('Showing 0 of 3 backlinks')
    await clearFilters()
    await addCreated(utcDay(2), null)
    await expect(showing).toHaveText('Showing 0 of 3 backlinks')
  })
})
