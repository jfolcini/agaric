import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * The Agenda's Sort by and Group by choices survive leaving the Journal and
 * coming back (#5735). App renders one view at a time (ViewDispatcher), so the
 * round trip remounts AgendaView and the choices are re-read from where they
 * were kept.
 *
 * A grouped list orders rows by its group's own key chain (AgendaResults) and
 * ignores Sort by, so the row order pins the grouping and only the Sort by
 * button's text pins the sort.
 * Default TODO + DOING list (seed.ts), grouped by state:
 *   DOING: Fix login bug (due today, P1), Review pull requests (due today, P2)
 *   TODO:  Submit report (yesterday), Buy groceries (today),
 *          Ship v2.0 release (tomorrow), Design new dashboard (next week)
 * The default grouping, by page, orders them differently.
 */

const BY_STATE = [
  /Fix login bug/,
  /Review pull requests/,
  /Submit report/,
  /Buy groceries/,
  /Ship v2\.0 release/,
  /Design new dashboard/,
]

test('Sort by and Group by choices are kept across a trip to Pages @journal', async ({ page }) => {
  await waitForBoot(page)
  await page.getByRole('tab', { name: 'Agenda view' }).click()
  const sortBy = page.getByRole('button', { name: 'Sort by', exact: true })
  const groupBy = page.getByRole('button', { name: 'Group by', exact: true })

  await sortBy.click()
  await page.getByRole('list', { name: 'Sort by' }).getByText('Priority', { exact: true }).click()
  await groupBy.click()
  await page.getByRole('list', { name: 'Group by' }).getByText('State', { exact: true }).click()

  const headers = page.getByTestId('agenda-group-header')
  const rows = page.getByTestId('agenda-results-item')
  await expect(sortBy).toHaveText('Sort by:Priority')
  await expect(groupBy).toHaveText('Group by:State')
  await expect(headers).toHaveText([/DOING/, /TODO/])
  await expect(rows).toHaveText(BY_STATE)

  await navigateToView(page, 'Pages')
  await expect(page.getByTestId('agenda-view')).toHaveCount(0)
  await navigateToView(page, 'Journal')

  await expect(sortBy).toHaveText('Sort by:Priority')
  await expect(groupBy).toHaveText('Group by:State')
  await expect(headers).toHaveText([/DOING/, /TODO/])
  await expect(rows).toHaveText(BY_STATE)
})
