/**
 * #4551 — hovering a `((ULID))` chip opens the peek, which shows what the chip
 * cannot.
 *
 * The chip is one capped line of the target's title. The peek adds the
 * target's location (space › page) and its reference count, so the assertion
 * is text that is present in the peek and absent from the chip — a peek that
 * merely echoed the chip back would fail it.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): GS_1 is the first block of "Getting
 * Started" ("Welcome to Agaric! …"). The test points QN_2, on "Quick Notes",
 * at it, so the chip and its target live on different pages.
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

const PEEK = '[data-testid="ref-peek"]'

test.describe('Block-reference peek', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('hovering a chip opens a peek carrying the target’s location', async ({ page }) => {
    await openPage(page, 'Quick Notes')
    await focusBlock(page, 1)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((Welcome', { delay: 30 })
    const suggestions = activeSuggestionList(page)
    await expect(suggestions.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    // Enter, not Escape: Escape discards the draft, and the chip would never
    // reach the saved block.
    await saveBlock(page, 'Enter')

    const chip = page.locator('[data-testid="block-static"] [data-testid="block-ref-chip"]').first()
    await expect(chip).toBeVisible()
    // The premise: the chip does not say where the target lives.
    await expect(chip).not.toContainText('Getting Started')

    await chip.hover()
    await page.waitForSelector(PEEK)
    const peek = page.locator(PEEK)
    await expect(peek).toContainText('Getting Started')
    await expect(peek).toContainText('Welcome to Agaric!')
    await expect(peek.getByRole('button', { name: 'Open' })).toBeVisible()

    // The native tooltip must not race the popover while it is open.
    await expect(chip).not.toHaveAttribute('title', /.*/)
  })
})
