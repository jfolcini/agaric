/**
 * #6972 — ticking a repeating task to DONE reloads the page to show its next
 * occurrence. Another task's checkbox clicked before that reload lands keeps
 * its new state, on screen and in the backend.
 */

import { blockRow } from './domain'
import {
  expect,
  ipc,
  openPage,
  reopenPage,
  seedSearchBlocks,
  settleBackend,
  test,
  waitForBoot,
} from './helpers'

const REPEATING = 'Water the plants'
const OTHER = 'Book the dentist'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('a task ticked while a repeating task completes keeps its state @editor @journal', async ({
  page,
}) => {
  const [repeating, other] = (await seedSearchBlocks(page, [
    { content: REPEATING, todo: 'DOING', due: 0, props: { repeat: '+1d' } },
    { content: OTHER, todo: 'TODO' },
  ])) as [string, string]
  await settleBackend(page)
  await openPage(page, 'Projects')

  // No settle between the clicks: the second lands while the first's reload is on its way.
  await blockRow(page, repeating).getByTestId('task-marker').click()
  await blockRow(page, other).getByTestId('task-marker').click()

  // The reload has landed once the next occurrence shows.
  const repeatingRows = page
    .locator('[data-testid="sortable-block"]')
    .filter({ hasText: REPEATING })
  await expect(repeatingRows).toHaveCount(2)
  await expect(blockRow(page, repeating).getByTestId('task-checkbox-done')).toHaveCount(1)
  await expect(blockRow(page, other).getByTestId('task-checkbox-doing')).toHaveCount(1)

  await reopenPage(page, 'Projects')
  await expect(blockRow(page, repeating).getByTestId('task-checkbox-done')).toHaveCount(1)
  await expect(blockRow(page, other).getByTestId('task-checkbox-doing')).toHaveCount(1)
  const stateOf = async (blockId: string) =>
    (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId })).todo_state
  expect(await stateOf(repeating)).toBe('DONE')
  expect(await stateOf(other)).toBe('DOING')
})
