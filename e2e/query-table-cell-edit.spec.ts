/**
 * #6743 — a cell of a query table edits its block's value in place.
 *
 * Seed data: BLOCK_MTG_1 ("Weekly standup notes") carries context=@office and
 * project=alpha; `project` is a select of alpha, beta and gamma, `context` text.
 */

import { expect, focusBlock, openPage, reopenPage, saveBlock, test, waitForBoot } from './helpers'

test('a query table cell edits its block and the value holds after navigating away and back @search @editor', async ({
  page,
}) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('{{query type:property key:project table:true}}', { delay: 20 })
  await saveBlock(page)

  const table = page
    .locator('[data-testid="sortable-block"]')
    .first()
    .locator('[data-testid="query-result"]')
  const row = table.getByRole('row').filter({ hasText: 'Weekly standup notes' })

  // A select cell opens its options; picking one is the write.
  await row.getByRole('button', { name: 'Edit project: alpha' }).click()
  await page.getByRole('option', { name: 'gamma' }).click()
  await expect(row.getByRole('button', { name: 'Edit project: gamma' })).toBeFocused()
  await expect(page.getByText('project updated')).toBeVisible()

  // A text cell opens on Enter, commits on Enter and hands the focus back closed.
  await row.getByRole('button', { name: 'Edit context: @office' }).focus()
  await page.keyboard.press('Enter')
  // A click in the open field stays in it; it does not fall through to the block.
  await page.getByRole('textbox', { name: 'context value' }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('@home')
  await page.keyboard.press('Enter')
  await expect(row.getByRole('button', { name: 'Edit context: @home' })).toBeFocused()

  // Escape closes an open cell and leaves its value alone.
  await page.keyboard.press('Enter')
  await page.keyboard.type('discarded')
  await page.keyboard.press('Escape')
  await expect(row.getByRole('button', { name: 'Edit context: @home' })).toBeFocused()

  await reopenPage(page, 'Getting Started')
  await expect(row.getByRole('button', { name: 'Edit project: gamma' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Edit context: @home' })).toBeVisible()
})
