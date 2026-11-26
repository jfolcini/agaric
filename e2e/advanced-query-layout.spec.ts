/**
 * Advanced query layout (#7040 P8, D6): a query that has run shows its results
 * first, under a one-line summary of the query whose *Edit query* button opens
 * the form; on a phone the form fits the screen with its add buttons in the
 * form's column; and result rows are the shared list row with a type icon.
 * Each is what one surface draws over IPC calls the mock models, so the mock
 * lane shows it failing.
 */
import { devices, type Locator, type Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  expectNoHorizontalOverflow,
  navigateToView,
  test,
  waitForBoot,
} from './helpers'

const pixel = devices['Pixel 7']
const PHONE = {
  viewport: { width: 412, height: 915 },
  userAgent: pixel.userAgent,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

function resultList(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Query results' })
}

function rootGroup(page: Page): Locator {
  return page.getByRole('group', { name: 'Filter', exact: true })
}

function editQuery(page: Page): Locator {
  return page.getByRole('button', { name: 'Edit query', exact: true })
}

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox()
  if (b === null) throw new Error('not laid out')
  return b
}

/** Save "tag work, sorted by Created" as a view, clear the builder, and load the view. */
async function loadWorkView(page: Page): Promise<void> {
  await navigateToView(page, 'Advanced query')
  await rootGroup(page).getByRole('button', { name: 'Add filter', exact: true }).click()
  // An anchored popover on a desktop, a bottom sheet on a phone.
  const pop = page.locator('[data-slot="popover-content"], [data-slot="sheet-content"]').last()
  await pop.getByRole('button', { name: /^Tag/ }).click()
  await pop.getByRole('button', { name: 'work', exact: true }).click()
  await page.getByRole('button', { name: 'Add sort', exact: true }).click()
  await page.getByRole('button', { name: 'Save the current query as a named view' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('Work blocks')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await page.getByRole('button', { name: 'Load "Work blocks"' }).click()
  await expect(resultList(page).getByRole('option')).toHaveCount(3)
}

/** The view's three results sit on screen below the folded form's summary. */
async function expectResultsFirst(page: Page): Promise<void> {
  const rows = resultList(page).getByRole('option')
  await expect(rows).toHaveCount(3)
  for (const row of await rows.all()) await expect(row).toBeInViewport({ ratio: 1 })
  await expect(editQuery(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(rootGroup(page)).toBeHidden()
  const summary = page.getByTestId('advanced-query-summary')
  await expect(summary).toHaveText('tag: work · sorted by Created ↑')
  expect((await box(summary)).y).toBeLessThan((await box(resultList(page))).y)
}

/** Load a saved view, check it opens on its results, come back to it, and unfold its form. */
async function resultsFirstJourney(page: Page): Promise<void> {
  await loadWorkView(page)
  await expectResultsFirst(page)

  // Coming back to a query that has run keeps the form folded.
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Advanced query')
  await expectResultsFirst(page)

  await editQuery(page).click()
  await expect(editQuery(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(rootGroup(page).getByRole('group', { name: 'tag: work', exact: true })).toBeVisible()
}

test("a loaded saved view shows its results first, under the folded form's summary @search", async ({
  page,
}) => {
  await resultsFirstJourney(page)
})

test.describe('on a phone @search @mobile', () => {
  test.use(PHONE)

  test("a loaded saved view shows its results first, under the folded form's summary", async ({
    page,
  }) => {
    await resultsFirstJourney(page)
  })

  test('the query form fits the screen, its add buttons in the form column', async ({ page }) => {
    await navigateToView(page, 'Advanced query')
    const row = resultList(page).getByRole('option').first()
    const rowHeight = Math.round((await box(row)).height)

    await page.getByRole('button', { name: 'Add sort', exact: true }).click()
    await page.getByRole('button', { name: 'Add summary', exact: true }).click()
    await chooseSelectOption(page, 'Summarize', 'Property')
    // Not `chooseSelectOption`: the date grouping adds a "Date to group by" picker.
    await page.getByRole('combobox', { name: 'Group by', exact: true }).click()
    await page.getByRole('option', { name: 'Date', exact: true }).click()
    await expect(page.getByTestId('advanced-query-group-date')).toBeVisible()
    await expectNoHorizontalOverflow(page)

    const form = page.getByRole('group', { name: 'Query controls' })
    const formLeft = Math.round((await box(form)).x)
    for (const name of ['Add sort', 'Add summary']) {
      const button = page.getByRole('button', { name, exact: true })
      expect(Math.round((await box(button)).x), name).toBe(formLeft)
    }

    // A summary's two pickers share a line; its property key takes the next.
    const opPicker = await box(page.getByRole('combobox', { name: 'Summary type' }))
    const target = await box(page.getByRole('combobox', { name: 'Summarize', exact: true }))
    const key = await box(page.getByRole('textbox', { name: 'Property to summarize' }))
    expect(Math.round(target.y)).toBe(Math.round(opPicker.y))
    expect(key.y).toBeGreaterThan(opPicker.y + opPicker.height)

    // NOT paints the 36 px of the All / Any segments beside it.
    const header = rootGroup(page).locator('> div').first()
    const not = header.getByRole('button', { name: 'NOT', exact: true })
    const op = header.getByRole('radiogroup', { name: 'Match' })
    expect(Math.round((await box(not)).height)).toBe(36)
    expect(Math.round((await box(op)).height)).toBe(36)

    // A result row is as tall as a Pages row.
    await navigateToView(page, 'Pages')
    const pageRow = page.getByRole('grid').getByRole('row').nth(1)
    expect(rowHeight).toBe(Math.round((await box(pageRow)).height))
  })
})

test('result rows carry a type icon and the shared list row height @search', async ({ page }) => {
  await navigateToView(page, 'Advanced query')
  const list = resultList(page)
  const type = (name: string | RegExp): Locator =>
    list.getByRole('option', { name, exact: true }).getByTestId('query-result-type')
  await expect(type('work')).toHaveAttribute('data-type', 'tag')
  await expect(type('Getting Started')).toHaveAttribute('data-type', 'page')
  await expect(type(/^\d{4}-\d{2}-\d{2}$/)).toHaveAttribute('data-type', 'journal')
  await expect(type('Weekly standup notes Meetings')).toHaveAttribute('data-type', 'block')
  // A task shows its state's checkbox instead.
  await expect(
    list.getByRole('option', { name: /^TODO Buy groceries/ }).locator('.task-checkbox'),
  ).toHaveCount(1)
  await expect(
    list
      .getByRole('option')
      .filter({ hasNot: page.locator('[data-testid="query-result-type"], .task-checkbox') }),
  ).toHaveCount(0)

  // `listRowVariants`' default density: py-2.5 around a text-sm line.
  for (const name of ['Getting Started', /^TODO Buy groceries/]) {
    expect((await box(list.getByRole('option', { name }).first())).height).toBe(40)
  }

  // An empty query starts with its form open.
  await expect(editQuery(page)).toHaveAttribute('aria-expanded', 'true')
})
