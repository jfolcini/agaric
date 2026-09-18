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
 * #5086 — Escape must then close it again. This lane is the only one that
 * mounts the App shell, whose `closeOverlays` handler intercepts the key
 * before the peek ever sees it; the component suite renders bare chips and so
 * passed all along.
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

type Page = import('@playwright/test').Page

const PEEK = '[data-testid="ref-peek"]'

/** Type a `((Welcome))` ref into QN_2, commit it, and focus the static chip. */
async function chipOnQuickNotes(page: Page) {
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
  return chip
}

test.describe('Block-reference peek — keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Alt+ArrowDown moves focus into the peek and Tab reaches its actions', async ({ page }) => {
    await chipOnQuickNotes(page)

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

  test('Escape closes a keyboard-opened peek and hands the chip back', async ({ page }) => {
    const chip = await chipOnQuickNotes(page)

    await page.keyboard.press('Alt+ArrowDown')
    const peek = page.locator(PEEK)
    await expect(peek).toBeFocused()
    await expect(peek).toContainText('Welcome to Agaric!')
    await expect(chip).toHaveAttribute('aria-expanded', 'true')

    await page.keyboard.press('Escape')

    await expect(peek).toHaveCount(0)
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    // The peek released the chip, rather than only tearing its own render down.
    await expect(chip).not.toHaveAttribute('data-peek-title-parked', '')
    await expect(chip).toBeFocused()
  })
})
