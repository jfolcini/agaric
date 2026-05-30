/**
 * E2E for the callout type picker (#215). The toolbar Callout button opens a
 * popover of the 5 variants; selecting one applies that callout (verified
 * against the static render after save).
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
    await editor.type('alert text')

    await page.getByRole('button', { name: 'Callout' }).click()
    await page.getByTestId('callout-type-warning').click()
    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    const callout = block.locator('[data-testid="callout-block"]')
    await expect(callout).toBeVisible()
    await expect(callout).toHaveAttribute('data-callout-type', 'warning')
    await expect(callout).toContainText('alert text')
  })
})
