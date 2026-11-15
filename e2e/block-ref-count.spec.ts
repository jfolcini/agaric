/**
 * #6746 — a referenced block shows how many blocks reference it, and the count
 * zooms the block, where its linked references list.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): GS_1 is the first block of "Getting
 * Started" ("Welcome to Agaric! …"). The test points QN_2, on "Quick Notes", at
 * it, then goes back: the count is read when the page opens again.
 */

import {
  activeSuggestionList,
  expect,
  focusBlock,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const COUNT = '[data-testid="ref-count-chip"]'

test.describe('Reference count on a referenced block @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a block referenced from another page shows the count, which zooms it', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
    await expect(page.locator(COUNT)).toHaveCount(0)

    await openPage(page, 'Quick Notes')
    await focusBlock(page, 1)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((Welcome', { delay: 30 })
    const suggestions = activeSuggestionList(page)
    await expect(suggestions.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    const targetId = await page
      .locator('[data-testid="block-ref-chip"]')
      .first()
      .getAttribute('data-id')
    await saveBlock(page, 'Enter')

    // Back by QN_1's link to the page.
    await page.locator('[data-testid="block-link-chip"]', { hasText: 'Getting Started' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    const target = page.locator(`[data-testid="sortable-block"][data-block-id="${targetId}"]`)
    const count = target.locator(COUNT)
    await expect(count).toHaveText('1')
    await expect(page.locator(COUNT)).toHaveCount(1)

    await count.click()
    await expect(page.getByRole('navigation', { name: /zoom breadcrumbs/i })).toBeVisible()
    await expect(page.locator('[data-testid="linked-references"]')).toContainText(
      'Jot down quick thoughts',
    )
  })
})
