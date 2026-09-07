/**
 * #4553 Phase 2 — the group-by picker offers `GroupKey::Property` and
 * `GroupKey::DateBucket`, and a grouped result renders for either.
 *
 * The mock's grouped path synthesises one bucket keyed by the `GroupKey`
 * type (`run_advanced_query` in `src/lib/tauri-mock/handlers/search.ts`),
 * so the bucket header reads `Property` / `DateBucket`; real bucket labels
 * are pinned by the engine tests (`agaric-store/src/query/tests.rs`).
 */
import { expect, navigateToView, test, waitForBoot } from './helpers'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('group by a property key and by a date bucket from the picker', async ({ page }) => {
  await navigateToView(page, 'Advanced Query')
  const groupBy = page.getByRole('combobox', { name: 'Group by' })
  await groupBy.click()
  await expect(page.getByRole('option')).toHaveText([
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
  await expect(section.getByTestId('advanced-query-group-key')).toHaveText('Property')

  await groupBy.click()
  await page.getByRole('option', { name: 'Date', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Date to group by' })).toHaveText('Due')
  const unit = page.getByRole('combobox', { name: 'Bucket size' })
  await expect(unit).toHaveText('Week')
  await unit.click()
  await page.getByRole('option', { name: 'Month', exact: true }).click()
  await expect(unit).toHaveText('Month')
  await expect(section.getByTestId('advanced-query-group-key')).toHaveText('DateBucket')
})
