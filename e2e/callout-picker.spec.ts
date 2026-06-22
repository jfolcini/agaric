/**
 * E2E for the callout type picker (#215, #1960). Turn into → Callout converts
 * the block to a default (info) callout; re-opening Turn into surfaces the
 * contextual type picker (the 5 variants) since the block is now a callout.
 * Selecting one applies that callout (verified against the static render).
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

test.describe('Callout type picker (#215)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('picking "Warning" applies a warning callout', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.pressSequentially('alert text')

    const blockEditor = page.locator('[data-testid="block-editor"]')
    // #1960 — Turn into → Callout (defaults to info), then re-open Turn into;
    // the contextual type picker appears for callouts → pick Warning.
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Callout' }).click()
    // Caret into the new callout so Turn into surfaces the type picker.
    // Active-state read is rAF-coalesced (#1489) — let it propagate.
    await editor.locator('blockquote').click()
    await page.waitForTimeout(250)
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    await page.getByTestId('callout-type-warning').click()
    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    const callout = block.locator('[data-testid="callout-block"]')
    await expect(callout).toBeVisible()
    await expect(callout).toHaveAttribute('data-callout-type', 'warning')
    await expect(callout).toContainText('alert text')
  })
})
