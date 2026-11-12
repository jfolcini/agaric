/**
 * #6544 — a query table shows the columns the user picked, in the order they
 * picked, and the choice is stored in the query block itself.
 *
 * Seed data: BLOCK_MTG_1 carries context=@office, project=alpha and
 * BLOCK_MTG_2 context=@remote, project=beta.
 */

import { expect, focusBlock, openPage, reopenPage, saveBlock, test, waitForBoot } from './helpers'

test('picked query table columns keep their order after navigating away and back @search @editor', async ({
  page,
}) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('{{query type:property key:project table:true}}', { delay: 20 })
  await saveBlock(page)

  const queryResult = page
    .locator('[data-testid="sortable-block"]')
    .first()
    .locator('[data-testid="query-result"]')
  const headers = queryResult.getByRole('columnheader')
  await expect(headers).toHaveText([
    'Content',
    'Status',
    'Priority',
    'Due Date',
    'Scheduled',
    'context',
    'project',
    'Page',
  ])

  const picker = queryResult.getByRole('button', { name: 'Choose columns' })
  for (const column of ['Status', 'Priority', 'Due Date', 'Scheduled']) {
    await picker.click()
    await page.getByRole('checkbox', { name: column, exact: true }).click()
    await page.keyboard.press('Escape')
  }
  await picker.click()
  await page.getByRole('button', { name: 'Move project left' }).click()
  await page.keyboard.press('Escape')
  await expect(headers).toHaveText(['Content', 'project', 'context', 'Page'])

  await reopenPage(page, 'Getting Started')
  await expect(headers).toHaveText(['Content', 'project', 'context', 'Page'])
  // Each row's cells follow the header order: project, then context.
  await expect(queryResult.getByRole('row').filter({ hasText: 'alpha' })).toContainText(
    'alpha@office',
  )
})
