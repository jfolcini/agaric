/**
 * The Advanced Query board (#6542): a State grouping laid out as one column
 * per task state. Each column runs the mock's flat `run_advanced_query` path
 * with its own `State` leaf, so a column that selects the wrong blocks, or a
 * board that keeps the list's single query, shows up here as cards in the
 * wrong column.
 */
import type { Locator, Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  expectNoHorizontalOverflow,
  navigateToView,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true })
const cards = (page: Page, name: string): Locator => column(page, name).getByRole('option')

async function openStateBoard(page: Page): Promise<void> {
  await navigateToView(page, 'Advanced Query')
  await expect(page.getByRole('radio', { name: 'Board' })).toBeDisabled()
  await chooseSelectOption(page, 'Group by', 'State')
  await page.getByRole('radio', { name: 'Board' }).click()
}

test('a State grouping shows as a board whose cards open their page @search', async ({ page }) => {
  await seedSearchBlocks(page, [
    { content: 'Board spec waiting', todo: 'TODO' },
    { content: 'Board spec shipped', todo: 'DONE' },
  ])
  await openStateBoard(page)

  await expect(page.getByTestId('query-board-column').getByRole('heading')).toHaveText([
    'TODO',
    'DOING',
    'DONE',
    'CANCELLED',
    'No value',
  ])
  await expect(cards(page, 'TODO').filter({ hasText: 'Board spec waiting' })).toHaveCount(1)
  await expect(cards(page, 'DONE').filter({ hasText: 'Board spec shipped' })).toHaveCount(1)
  await expect(cards(page, 'TODO').filter({ hasText: 'Board spec shipped' })).toHaveCount(0)
  // No seeded block is cancelled: the value keeps its column, empty.
  await expect(column(page, 'CANCELLED').getByText('No blocks in “CANCELLED”')).toBeVisible()
  await expect(cards(page, 'CANCELLED')).toHaveCount(0)

  // The keyboard reaches a column and opens the card under its cursor: the
  // newest TODO, seeded above on the Projects page.
  await column(page, 'TODO').getByRole('listbox', { name: 'TODO' }).focus()
  await expect(cards(page, 'TODO').first()).toHaveAttribute('aria-selected', 'true')
  await expect(cards(page, 'TODO').first()).toContainText('Board spec waiting')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveText('Projects')
})

test('the board scrolls sideways inside a phone-width view @search @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openStateBoard(page)

  await expect(cards(page, 'TODO').first()).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await column(page, 'No value').scrollIntoViewIfNeeded()
  await expect(column(page, 'No value')).toBeInViewport()
})
