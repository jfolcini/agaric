/**
 * #4551 — `Alt+ArrowDown` on a focused `((ULID))` chip must put focus INSIDE
 * the peek, so its `Open` / `Copy reference` actions are reachable without a
 * pointer.
 *
 * The peek renders `visibility: hidden` until `computePosition` resolves, and
 * a hidden element refuses focus in a real browser (jsdom accepts it, so the
 * component suite cannot see this). Focus then stayed on the chip and the
 * first `Tab` left the peek entirely, dismissing it through `focusin`.
 *
 * Setup mirrors `block-ref-peek.spec.ts`: point QN_2 on "Quick Notes" at GS_1
 * on "Getting Started".
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

test.describe('Block-reference peek — keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Alt+ArrowDown moves focus into the peek and Tab reaches its actions', async ({ page }) => {
    await openPage(page, 'Quick Notes')
    await focusBlock(page, 1)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((Welcome', { delay: 30 })
    const suggestions = activeSuggestionList(page)
    await expect(suggestions.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await saveBlock(page, 'Enter')

    const chip = page.locator('[data-testid="block-static"] [data-testid="block-ref-chip"]').first()
    await expect(chip).toBeVisible()
    await chip.focus()

    await page.keyboard.press('Alt+ArrowDown')
    const peek = page.locator(PEEK)
    await expect(peek).toBeVisible()
    await expect(peek).toBeFocused()

    // The payload lands after the first placement and re-runs `computePosition`;
    // focus must survive that round trip, not only the opening one.
    await expect(peek).toContainText('Welcome to Agaric!')
    await expect(peek).toBeFocused()

    // What the focus is FOR: the actions are one Tab away, and tabbing does
    // not dismiss the peek.
    await page.keyboard.press('Tab')
    await expect(peek.getByRole('button', { name: 'Open' })).toBeFocused()
    await expect(peek).toBeVisible()
  })
})
