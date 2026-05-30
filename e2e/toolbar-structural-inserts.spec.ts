/**
 * E2E for the structural toolbar buttons (#253).
 *
 * Regression guard: the Ordered list / Divider / Callout toolbar buttons
 * dispatch `INSERT_ORDERED_LIST` / `INSERT_DIVIDER` / `INSERT_CALLOUT` DOM
 * events. These previously had NO consumer, so the buttons were silent
 * no-ops. The fix wires them in `useBlockTreeEventListeners` to the same
 * content-edit path the matching slash commands use. These tests click the
 * real buttons and assert the focused block's content actually changes.
 */

import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

test.describe('Structural toolbar inserts (#253)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Divider button turns the focused block into a horizontal rule', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type('divider test')

    await page.getByRole('button', { name: 'Divider' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="horizontal-rule"]')).toBeVisible()
  })

  test('Ordered list button prefixes the focused block with "1. "', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type('first item')

    await page.getByRole('button', { name: 'Ordered list' }).click()
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const ol = firstBlock.locator('ol')
    await expect(ol).toBeVisible()
    await expect(ol).toContainText('first item')
  })

  test('Callout button converts the focused block into a blockquote (callout markdown)', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type('heads up')

    await page.getByRole('button', { name: 'Callout' }).click()

    // The consumer fires and rewrites the block to `> [!INFO] heads up`, which
    // the editor mounts as a blockquote. NOTE: the `[!INFO]` callout *type* is
    // currently dropped on the editor round-trip (stock TipTap Blockquote has
    // no `calloutType` attribute) — a pre-existing bug that affects the
    // `/callout` slash command identically (tracked separately). This test
    // therefore asserts the consumer fired (plain → blockquote), matching the
    // slash command's current behaviour; upgrade to `callout-block` once the
    // round-trip bug is fixed.
    const quote = editor.locator('blockquote')
    await expect(quote).toBeVisible()
    await expect(quote).toContainText('heads up')
  })
})
