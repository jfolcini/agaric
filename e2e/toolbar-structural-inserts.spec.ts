/**
 * E2E for the structural transforms in the "Turn into" menu (#253, #1960).
 *
 * The standalone Ordered list / Divider / Callout toolbar buttons were
 * REPLACED by the Turn into (Pilcrow) menu (#1960). These tests open that menu
 * and click the entries — which dispatch `TURN_INTO_BLOCK` / `INSERT_DIVIDER`
 * to the same content-edit path the matching slash commands use — and assert
 * the focused block's content actually changes.
 */

import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

/** Open the Turn into popover from the focused block's toolbar. */
async function openTurnInto(page: import('@playwright/test').Page) {
  await page
    .locator('[data-testid="block-editor"]')
    .getByRole('button', { name: 'Turn into', exact: true })
    .click()
}

test.describe('Structural transforms via Turn into (#253, #1960)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Divider entry turns the focused block into a horizontal rule', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('divider test')

    await openTurnInto(page)
    await page.getByRole('menuitem', { name: 'Divider' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="horizontal-rule"]')).toBeVisible()
  })

  test('Ordered list entry prefixes the focused block with "1. "', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('first item')

    await openTurnInto(page)
    await page.getByRole('menuitemradio', { name: 'Ordered list' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const ol = firstBlock.locator('ol')
    await expect(ol).toBeVisible()
    await expect(ol).toContainText('first item')
  })

  test('Bullet list entry prefixes the focused block with "- " (#1959)', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('a bullet')

    await openTurnInto(page)
    await page.getByRole('menuitemradio', { name: 'Bullet list' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const ul = firstBlock.locator('ul')
    await expect(ul).toBeVisible()
    await expect(ul).toContainText('a bullet')
  })

  test('Callout entry converts the focused block to a callout', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('heads up')

    await openTurnInto(page)
    await page.getByRole('menuitemradio', { name: 'Callout' }).click()

    const quote = editor.locator('blockquote')
    await expect(quote).toBeVisible()
    await expect(quote).toContainText('heads up')
  })
})
