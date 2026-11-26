import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * The Agenda's Sort by and Group by choices survive leaving the Journal and
 * coming back (#5735). App renders one view at a time (ViewDispatcher), so the
 * round trip remounts AgendaView and the choices are re-read from where they
 * were kept.
 *
 * A grouped list orders rows by its group's own key chain (AgendaResults) and
 * ignores Sort by, so the row order pins the grouping and only the Sort by
 * list's current choice pins the sort.
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
  const view = page.getByRole('button', { name: 'View', exact: true })
  const sortBy = page.getByRole('list', { name: 'Sort by' })
  const groupBy = page.getByRole('list', { name: 'Group by' })
  const current = (list: typeof sortBy, name: string) =>
    expect(list.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'true')

  await view.click()
  await sortBy.getByText('Priority', { exact: true }).click()
  await groupBy.getByText('State', { exact: true }).click()

  const headers = page.getByTestId('agenda-group-header')
  const rows = page.getByTestId('agenda-results-item')
  await current(sortBy, 'Priority')
  await current(groupBy, 'State')
  await page.keyboard.press('Escape')
  await expect(headers).toHaveText([/DOING/, /TODO/])
  await expect(rows).toHaveText(BY_STATE)

  await navigateToView(page, 'Pages')
  await expect(page.getByTestId('agenda-view')).toHaveCount(0)
  await navigateToView(page, 'Agenda')

  await expect(headers).toHaveText([/DOING/, /TODO/])
  await expect(rows).toHaveText(BY_STATE)
  await view.click()
  await current(sortBy, 'Priority')
  await current(groupBy, 'State')
})
