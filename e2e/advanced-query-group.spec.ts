/**
 * #4553 Phase 2 — the group-by picker offers `GroupKey::Property` and
 * `GroupKey::DateBucket`.
 *
 * The backend labels a bucket by its value (`(none)` for the seed, which has
 * no `status` and no due dates). So the first test asserts that a grouped
 * result renders for a property key and that the date-bucket controls work;
 * real bucket labels are pinned by the engine tests (`agaric-store/src/query/tests.rs`)
 * and by the `@real-only` tests below.
 */
import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  chooseSelectOption,
  expect,
  ipc,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('group by a property key and by a date bucket from the picker @search', async ({ page }) => {
  await navigateToView(page, 'Advanced query')
  const groupBy = page.getByRole('combobox', { name: 'Group by' })
  await groupBy.click()
  // Scoped to the picker: an open Select hides the page from assistive tech, but the results'
  // live region stays exposed, so results that land after the picker opens add their options.
  await expect(page.locator('[data-slot="select-content"]').getByRole('option')).toHaveText([
    'None',
    'Tag',
    'Page',
    'State',
    'Block type',
    'Priority',
    'Property',
    'Date',
  ])
  await page.getByRole('option', { name: 'Property', exact: true }).click()
  await page.getByRole('textbox', { name: 'Property key to group by' }).fill('status')

  const section = page.getByTestId('advanced-query-group-section')
  await expect(section.first()).toBeVisible()

  await groupBy.click()
  await page.getByRole('option', { name: 'Date', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Date to group by' })).toHaveText('Due')
  const unit = page.getByRole('combobox', { name: 'Bucket size' })
  await expect(unit).toHaveText('Week')
  await unit.click()
  await page.getByRole('option', { name: 'Month', exact: true }).click()
  await expect(unit).toHaveText('Month')
})

/** Each group's header as `key | count | aggregate chip…`. */
function groupHeaders(page: Page): Promise<string[]> {
  return page.getByTestId('advanced-query-group-section').evaluateAll((sections) =>
    sections.map((section) => {
      const header = section.querySelector('header')
      const chips = header?.querySelectorAll('[data-testid="advanced-query-aggregate-chip"]')
      return [
        header?.querySelector('[data-testid="advanced-query-group-key"]')?.textContent ?? '',
        header?.children[1]?.textContent ?? '',
        ...[...(chips ?? [])].map((chip) => chip.textContent ?? ''),
      ].join(' | ')
    }),
  )
}

/** Type `term` as the full-text term once the index holds its `count` blocks. */
async function scopeTo(page: Page, term: string, count: number): Promise<void> {
  // The materializer writes the FTS rows after the seed; poll before the view caches an answer.
  await expect
    .poll(async () => {
      const res = await ipc<{ items: unknown[] }>(page, 'search_blocks', {
        query: term,
        cursor: null,
        limit: 50,
        filter: { scope: { kind: 'spaces', space_ids: [SEED_IDS.SPACE_PERSONAL] } },
      })
      return res.items.length
    })
    .toBe(count)
  await navigateToView(page, 'Advanced query')
  await page.getByRole('searchbox', { name: 'Full-text search' }).fill(term)
  await expect(page.getByTestId('advanced-query-total')).toHaveText(`${count} matching blocks`)
}

// `@real-only`: the mock computes no groups.
test(
  'groups by state with per-group counts and a Count summary, kept after leaving @search',
  { tag: '@real-only' },
  async ({ page }) => {
    await seedSearchBlocks(page, [
      { content: 'grpword one', todo: 'TODO' },
      { content: 'grpword two', todo: 'TODO' },
      { content: 'grpword six', todo: 'TODO' },
      { content: 'grpword ten', todo: 'DOING' },
      { content: 'grpword win', todo: 'DOING' },
      { content: 'grpword cup', todo: 'DONE' },
    ])
    await scopeTo(page, 'grpword', 6)
    await chooseSelectOption(page, 'Group by', 'State')
    // `gcount DESC, gkey ASC`; grouped mode's total counts the buckets.
    await expect
      .poll(() => groupHeaders(page))
      .toEqual(['TODO | 3 blocks', 'DOING | 2 blocks', 'DONE | 1 block'])
    await expect(page.getByTestId('advanced-query-total')).toHaveText('3 groups')

    await page.getByRole('button', { name: 'Add summary', exact: true }).click()
    const counted = [
      'TODO | 3 blocks | Count: 3',
      'DOING | 2 blocks | Count: 2',
      'DONE | 1 block | Count: 1',
    ]
    const global = page
      .getByTestId('advanced-query-aggregate-summary')
      .getByTestId('advanced-query-aggregate-chip')
    await expect.poll(() => groupHeaders(page)).toEqual(counted)
    await expect(global).toHaveText(['Count: 6'])

    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Advanced query')
    await expect.poll(() => groupHeaders(page)).toEqual(counted)
    await expect(global).toHaveText(['Count: 6'])
    await expect(page.getByTestId('advanced-query-total')).toHaveText('3 groups')
  },
)

test(
  "a block holding two items of a list key sits in both items' groups (#6741) @search",
  { tag: '@real-only' },
  async ({ page }) => {
    await ipc(page, 'create_property_def', {
      spaceId: SEED_IDS.SPACE_PERSONAL,
      key: 'authors',
      valueType: 'text',
      options: null,
      multiple: true,
    })
    const ids = await seedSearchBlocks(page, [
      { content: 'lstword one' },
      { content: 'lstword two' },
      { content: 'lstword six' },
    ])
    const lists = [['Ann', 'Bob'], ['Ann', 'Ann'], ['Cy']]
    await Promise.all(
      ids.map((blockId, i) =>
        ipc(page, 'set_property', {
          blockId,
          key: 'authors',
          value: {
            value_text: null,
            value_num: null,
            value_date: null,
            value_ref: null,
            value_bool: null,
            value_list: lists[i],
          },
        }),
      ),
    )
    await scopeTo(page, 'lstword', 3)
    await chooseSelectOption(page, 'Group by', 'Property')
    await page.getByRole('textbox', { name: 'Property key to group by' }).fill('authors')
    // Block two's repeated Ann counts once.
    const groups = ['Ann | 2 blocks', 'Bob | 1 block', 'Cy | 1 block']
    await expect.poll(() => groupHeaders(page)).toEqual(groups)

    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Advanced query')
    await expect.poll(() => groupHeaders(page)).toEqual(groups)
  },
)
