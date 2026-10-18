import type { Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  openPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * The per-block History sheet (Ctrl+Shift+Y) lists only the focused block's
 * ops (`get_block_history`). The mock keeps a real op log and filters it by
 * block id, so a sheet showing another block's edits, or none, shows here.
 * `keyboard-tabs-drawers.spec.ts` asserts only that the sheet opens.
 */

const GS_1 = '0000000000000000000BLOCK01'
const GS_3 = '0000000000000000000BLOCK03'

async function editBlock(page: Page, id: string, text: string) {
  await focusBlockById(page, id)
  await replaceEditorText(page, text)
  await saveBlock(page, 'Escape')
  await expect(page.locator(`[data-block-id="${id}"] [data-testid="block-static"]`)).toHaveText(
    text,
  )
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test("Ctrl+Shift+Y lists the focused block's edits and none of another block's @editor @pages", async ({
  page,
}) => {
  await openPage(page, 'Getting Started')
  await editBlock(page, GS_1, 'Alpha first edit')
  await editBlock(page, GS_1, 'Alpha second edit')
  await editBlock(page, GS_3, 'Bravo only edit')

  await focusBlockById(page, GS_1)
  await page.keyboard.press('Control+Shift+Y')

  const sheet = page.getByRole('dialog', { name: 'Block History' })
  const rows = sheet.locator('[data-testid^="block-history-item-"]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Alpha second edit')
  await expect(rows.nth(1)).toContainText('Alpha first edit')
  await expect(sheet).not.toContainText('Bravo')
})
