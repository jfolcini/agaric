/**
 * #6544 — one task, one checkbox: the Due panel, the Agenda and a query row
 * draw a task's state with the block's own checkbox, and the Agenda's toggles
 * it as a block's does.
 */

import {
  expect,
  focusBlock,
  ipc,
  navigateToView,
  openPage,
  runAxe,
  saveBlock,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

const TAG_WORK = '000000000000000000000TAG01'
const TASK = 'Call the plumber'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-14T10:00:00') })
  await waitForBoot(page)
})

test('a TODO task shows the block checkbox in a block, the Due panel, the Agenda and a query row @journal @editor @search', async ({
  page,
}) => {
  await seedSearchBlocks(page, [{ content: TASK, todo: 'TODO', due: 0, tagIds: [TAG_WORK] }])
  const todoBox = '[data-testid="task-marker"] [data-testid="task-checkbox-todo"]'

  // Leave and re-enter the journal so the Due panel fetches the seeded task.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  const dueRow = page.getByTestId('due-panel-item').filter({ hasText: TASK })
  await expect(dueRow.locator(todoBox)).toHaveCount(1)

  await page.getByRole('tab', { name: 'Agenda view' }).click()
  const agendaRow = page.getByTestId('agenda-results-item').filter({ hasText: TASK })
  await expect(agendaRow.locator(todoBox)).toHaveCount(1)

  await openPage(page, 'Projects')
  const blockRow = page.locator('[data-testid="sortable-block"]').filter({ hasText: TASK })
  await expect(blockRow.locator(todoBox)).toHaveCount(1)

  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('{{query type:tag expr:work}}', { delay: 20 })
  await saveBlock(page)
  const queryRow = page.getByTestId('query-result-item').filter({ hasText: TASK })
  await expect(queryRow.locator('[data-testid="task-checkbox-todo"]')).toHaveCount(1)
})

test('the Agenda checkbox cycles the task as a block does, to DONE @journal', async ({ page }) => {
  const [id] = await seedSearchBlocks(page, [{ content: TASK, todo: 'TODO', due: 0 }])
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await page.getByRole('tab', { name: 'Agenda view' }).click()
  const marker = page
    .getByTestId('agenda-results-item')
    .filter({ hasText: TASK })
    .getByTestId('task-marker')

  await marker.click()
  await expect(marker.getByTestId('task-checkbox-doing')).toHaveCount(1)
  await marker.click()

  await expect
    .poll(
      async () =>
        (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId: id })).todo_state,
    )
    .toBe('DONE')
  // The click toggled in place: the journal is still showing the Agenda.
  await expect(page.getByTestId('agenda-view')).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) {
  test(`the Agenda's task checkboxes have no axe violations in the ${theme} theme @journal`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate((t) => localStorage.setItem('theme-preference', t), theme)
    await page.reload()
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Agenda view' }).click()
    await expect(page.getByTestId('agenda-view').getByTestId('task-marker').first()).toBeVisible()

    const { violations } = await runAxe(page, '[data-testid="agenda-view"]')
    expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
      [],
    )
  })
}
