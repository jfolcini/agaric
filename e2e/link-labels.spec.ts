/**
 * #5160 D9 — a typed `[[Page|label]]` becomes a link chip showing the label,
 * and the label survives the block's save and a navigation round trip through
 * the mock (which resets on reload, so the durable-read hop is leaving the page
 * and coming back — `e2e-tauri/link-label-source-roundtrip.e2e.ts` covers the
 * real backend).
 */

import { expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

test.describe('[[Page|label]] links (#5160 D9)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the chip shows the label, in the editor, when saved and when reopened', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[Quick Notes|the notes]]', { delay: 30 })

    const editorChip = page.locator(
      '[data-testid="block-editor"] [data-testid="block-link-chip"][data-label="the notes"]',
    )
    await expect(editorChip).toHaveText('the notes')
    // The page title stays reachable as the tooltip.
    await expect(editorChip).toHaveAttribute('title', 'Quick Notes')

    // Enter at the end commits the block (Escape discards the edit).
    await saveBlock(page)
    const staticChip = page.locator(
      '[data-testid="block-static"] [data-testid="block-link-chip"]',
      {
        hasText: 'the notes',
      },
    )
    await expect(staticChip).toBeVisible()
    await expect(staticChip).toHaveAttribute('title', 'Quick Notes')

    // Leave and come back: the rows are re-fetched and re-parsed from the store.
    // The way back is the quick-access bar, since the visited page now sits
    // there as well as in the Pages list.
    await openPage(page, 'Quick Notes')
    await page
      .getByTestId('quick-access-bar')
      .getByRole('button', { name: 'Getting Started' })
      .click()
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="block-static"] [data-testid="block-link-chip"]', {
        hasText: 'the notes',
      }),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="block-static"] [data-testid="block-link-chip"]', {
        hasText: 'the notes',
      }),
    ).toHaveCount(1)
  })

  test('a label equal to the page title is not kept: the chip reads as the title', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[Quick Notes|Quick Notes]]', { delay: 30 })

    const chip = page.locator('[data-testid="block-editor"] [data-testid="block-link-chip"]', {
      hasText: 'Quick Notes',
    })
    await expect(chip).toBeVisible()
    await expect(chip).not.toHaveAttribute('data-label', /.+/)
  })
})
