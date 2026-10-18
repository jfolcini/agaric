import type { Locator, Page } from '@playwright/test'

import { expect, ipc, openAddFilter, test, waitForBoot } from './helpers'

/**
 * The Agenda filter builder narrows the rendered list by status, by priority
 * and by tag, alone and together, and "Clear all filters" restores the full
 * list (#5366). Assertions read the rendered rows, never the IPC payload.
 *
 * Unfiltered, the agenda lists every dated block plus undated tasks: the
 * eight seeded tasks below (seed.ts). The spec adds one tag, `errand`, through
 * the mock IPC: the seeded `work` and `personal` tags are also referenced
 * inline by a Getting Started block, a `block_tag_refs` row the mock does not
 * model, so a filter on them would pin seed drift.
 *
 * | Task                  | Status | Priority | errand |
 * |-----------------------|--------|----------|--------|
 * | Buy groceries         | TODO   | 1        | yes    |
 * | Review pull requests  | DOING  | 2        |        |
 * | Write documentation   | DONE   | 3        |        |
 * | Ship v2.0 release     | TODO   | 1        |        |
 * | Fix login bug         | DOING  | 1        | yes    |
 * | Update dependencies   | DONE   |          |        |
 * | Design new dashboard  | TODO   | 2        | yes    |
 * | Submit report         | TODO   | 1        |        |
 *
 * TODO, priority 1 and errand together match only Buy groceries, and dropping
 * any one of the three admits another task, so the combined case fails if any
 * dimension is ignored.
 */

const PERSONAL = 'SPACE_PERSONAL'
// SEED_IDS (src/lib/tauri-mock/seed.ts): BLOCK_DAILY_3, BLOCK_PROJ_2, BLOCK_PROJ_4.
const ERRAND_TASKS = [
  '0000000000000000000BLOCK10',
  '0000000000000000000BLOCK14',
  '0000000000000000000BLOCK16',
]

const ALL_TASKS = [
  'Buy groceries',
  'Review pull requests',
  'Write documentation',
  'Ship v2.0 release',
  'Fix login bug',
  'Update dependencies',
  'Design new dashboard',
  'Submit report',
]

async function seedErrandTag(page: Page): Promise<void> {
  const tag = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'tag',
    content: 'errand',
    parentId: null,
    index: null,
    scope: { kind: 'active', space_id: PERSONAL },
    blockId: null,
  })
  for (const blockId of ERRAND_TASKS) await ipc(page, 'add_tag', { blockId, tagId: tag.id })
}

/** The task titles the agenda renders, sorted; one read per poll so a list mid-refetch never mixes. */
async function listedTasks(page: Page): Promise<string[]> {
  const rows = await page.getByTestId('agenda-results-item').allTextContents()
  return rows.map((text) => ALL_TASKS.find((title) => text.includes(title)) ?? text).toSorted()
}

async function expectListed(page: Page, titles: string[]): Promise<void> {
  await expect.poll(() => listedTasks(page)).toEqual(titles.toSorted())
}

async function addFilter(
  page: Page,
  dimension: string,
  pickValue: (popover: Locator) => Promise<void>,
): Promise<void> {
  const popover = await openAddFilter(page)
  await popover.getByRole('button', { name: dimension, exact: true }).click()
  await pickValue(popover)
  await popover.getByRole('button', { name: 'Apply filter', exact: true }).click()
  await expect(popover).toBeHidden()
}

function check(choice: string) {
  return (popover: Locator) => popover.getByRole('checkbox', { name: choice, exact: true }).check()
}

async function pickErrand(popover: Locator): Promise<void> {
  await popover.getByRole('combobox', { name: 'Tag name', exact: true }).fill('errand')
  await popover.getByRole('option', { name: /^errand/ }).click()
}

async function clearAllFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Clear all filters', exact: true }).click()
}

test.describe('Agenda filter builder narrows the rendered list (#5366) @journal @search', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedErrandTag(page)
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.getByTestId('agenda-filter-builder')).toBeVisible()
    // The agenda opens on its default TODO + DOING status filter.
    await clearAllFilters(page)
    await expectListed(page, ALL_TASKS)
  })

  test('status alone, then clearing restores the full list', async ({ page }) => {
    await addFilter(page, 'Status', check('TODO'))
    await expectListed(page, [
      'Buy groceries',
      'Ship v2.0 release',
      'Design new dashboard',
      'Submit report',
    ])

    await clearAllFilters(page)
    await expectListed(page, ALL_TASKS)
  })

  test('priority alone, then clearing restores the full list', async ({ page }) => {
    await addFilter(page, 'Priority', check('1'))
    await expectListed(page, [
      'Buy groceries',
      'Ship v2.0 release',
      'Fix login bug',
      'Submit report',
    ])

    await clearAllFilters(page)
    await expectListed(page, ALL_TASKS)
  })

  test('tag alone, then clearing restores the full list', async ({ page }) => {
    await addFilter(page, 'Tag', pickErrand)
    await expectListed(page, ['Buy groceries', 'Fix login bug', 'Design new dashboard'])

    await clearAllFilters(page)
    await expectListed(page, ALL_TASKS)
  })

  test('status, priority and tag combine, then clearing restores the full list', async ({
    page,
  }) => {
    await addFilter(page, 'Status', check('TODO'))
    await addFilter(page, 'Priority', check('1'))
    await expectListed(page, ['Buy groceries', 'Ship v2.0 release', 'Submit report'])

    await addFilter(page, 'Tag', pickErrand)
    await expectListed(page, ['Buy groceries'])

    await clearAllFilters(page)
    await expectListed(page, ALL_TASKS)
  })
})

/**
 * A date preset and a property filter AND with the default TODO + DOING
 * status filter, and removing them returns the default list (#5735). The clock
 * is pinned to a Wednesday so "This week" holds yesterday, today and tomorrow
 * whichever day the week starts on, and never the task due a week out.
 *
 * `context = @office` goes on one task due next week, so neither filter alone
 * yields the combined result.
 */
test.describe('Agenda date preset and property filter (#5735) @journal @search', () => {
  // SEED_IDS (src/lib/tauri-mock/seed.ts): BLOCK_PROJ_1, BLOCK_PROJ_2, BLOCK_PROJ_4.
  const OFFICE_TASKS = [
    '0000000000000000000BLOCK13',
    '0000000000000000000BLOCK14',
    '0000000000000000000BLOCK16',
  ]
  const DEFAULT_LIST = [
    'Buy groceries',
    'Review pull requests',
    'Ship v2.0 release',
    'Fix login bug',
    'Design new dashboard',
    'Submit report',
  ]

  test('Due this week and a property narrow the default list, and removing them restores it', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-10-14T10:00:00'))
    await waitForBoot(page)
    for (const blockId of OFFICE_TASKS) {
      await ipc(page, 'set_property', { blockId, key: 'context', value: { value_text: '@office' } })
    }
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expectListed(page, DEFAULT_LIST)

    await addFilter(page, 'Due date', check('This week'))
    await expectListed(page, [
      'Buy groceries',
      'Review pull requests',
      'Ship v2.0 release',
      'Fix login bug',
      'Submit report',
    ])

    await addFilter(page, 'Property', async (popover) => {
      await popover.getByRole('combobox', { name: 'Property key', exact: true }).click()
      await page.getByRole('option', { name: 'context', exact: true }).click()
      await popover.getByRole('textbox', { name: 'Value (optional)', exact: true }).fill('@office')
    })
    await expectListed(page, ['Ship v2.0 release', 'Fix login bug'])

    await page.getByRole('button', { name: 'Remove context = @office filter', exact: true }).click()
    await page.getByRole('button', { name: 'Remove Due date filter', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Edit Status: TODO, DOING filter' })).toBeVisible()
    await expectListed(page, DEFAULT_LIST)
  })
})
