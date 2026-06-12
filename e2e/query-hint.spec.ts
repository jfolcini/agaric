import { expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * E2E for the inline `{{query …}}` syntax-hint affordance (#907).
 *
 * The hint is passive ghost text (a `.query-hint` widget decoration), accepted
 * on Tab. The whole point of #907 is that it must NEVER intercept Enter — the
 * first attempt used a Suggestion popup whose Enter handler ate the keystroke,
 * so blocks never flushed. These specs pin that Enter always saves the block
 * even while a hint is on screen.
 *
 * Setup mirrors `query-blocks.spec.ts` (same seed data, same QueryResult
 * assertions).
 */

test.describe('Query syntax hint', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('typing a full query and pressing Enter saves the block (hints never block save)', async ({
    page,
  }) => {
    await focusBlock(page)

    // Type a complete query. As the key segment is typed a ghost hint may
    // appear, but it must not interfere with continuing to type or saving.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })

    // Enter must save — NOT get swallowed by a hint. saveBlock() asserts the
    // block transitioned to its static (saved) rendering.
    await saveBlock(page)

    // Block now renders as a QueryResult => the block flushed successfully.
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const queryResult = firstBlock.locator('[data-testid="query-result"]')
    await expect(queryResult).toBeVisible({ timeout: 5000 })
    await expect(queryResult).toContainText('3 result', { timeout: 5000 })
  })

  test('a ghost hint appears mid-key and Enter still saves while it is visible', async ({
    page,
  }) => {
    await focusBlock(page)

    await page.keyboard.press('ControlOrMeta+a')
    // Stop after a partial key prefix so a hint is on screen.
    await page.keyboard.type('{{query ta', { delay: 20 })

    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    const hint = editor.locator('[data-testid="query-hint"]')
    await expect(hint).toBeVisible({ timeout: 3000 })
    // Sanity: it is ghost text, NOT a suggestion popup (which would eat Enter).
    await expect(page.locator('.suggestion-popup')).toHaveCount(0)

    // Accept on Tab → the key + colon separator are committed into the doc.
    await page.keyboard.press('Tab')
    // Finish the query and save with Enter.
    await page.keyboard.type('work}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const queryResult = firstBlock.locator('[data-testid="query-result"]')
    await expect(queryResult).toBeVisible({ timeout: 5000 })
    await expect(queryResult).toContainText('3 result', { timeout: 5000 })
  })
})
