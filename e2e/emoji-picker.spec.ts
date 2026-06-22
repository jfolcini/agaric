import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for the inline `:` emoji picker (#130 Phase 2).
 *
 * Verifies the headline flow (`:shortcode` → native emoji) and, critically,
 * that the new `:` trigger coexists with the existing `::` property trigger
 * and ordinary colons:
 *   - `:joy` opens the emoji picker; Enter inserts 😂 and removes `:joy`.
 *   - `::` still opens the PROPERTY picker (emoji stays dormant).
 *   - a bare `:` followed by a space opens nothing.
 */

const JOY = '\u{1F602}'

test.describe('Inline emoji picker — `:` trigger (#130)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('`:joy` opens the picker and Enter inserts the native emoji', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' :joy', { delay: 30 })

    const popup = page.locator('[data-testid="suggestion-popup"]')
    await expect(popup).toBeVisible()
    // The full emoji set (#286) returns several `joy*` matches (joy, joy_cat,
    // joystick…); `joy` ranks first, which is the item Enter selects below.
    await expect(
      popup.locator('[data-testid="suggestion-item"]', { hasText: 'joy' }).first(),
    ).toBeVisible()

    await page.keyboard.press('Enter')

    // The native emoji is inserted and the `:joy` query text is gone.
    await expect(editor).toContainText(JOY)
    await expect(editor).not.toContainText(':joy')
  })

  test('typing a full `:joy:` (closing colon) auto-replaces to the emoji', async ({ page }) => {
    // #281 — the input rule converts a COMPLETED `:shortcode:` the instant the
    // closing colon is typed (Slack/GitHub style), no Enter / popup selection.
    const editor = await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' :joy:', { delay: 30 })

    await expect(editor).toContainText(JOY)
    await expect(editor).not.toContainText(':joy')
    // The suggestion popup is dismissed once the text is replaced.
    await expect(page.locator('[data-testid="suggestion-popup"]')).toHaveCount(0)
  })

  test('the toolbar emoji button opens the browse-grid picker', async ({ page }) => {
    // #281 — the mouse-first twin of the `:` typeahead. The button dispatches
    // OPEN_EMOJI_PICKER, which opens the same dialog `/emoji` does.
    await focusBlock(page)
    let emojiBtn = page.getByRole('button', { name: /emoji/i }).first()
    if (!(await emojiBtn.isVisible().catch(() => false))) {
      // It can sit in the overflow popover under width pressure.
      await page.getByRole('button', { name: 'More', exact: true }).click()
      emojiBtn = page.getByRole('button', { name: /emoji/i }).first()
    }
    await emojiBtn.click()
    await expect(page.locator('[data-testid="emoji-picker"]')).toBeVisible()
  })

  test('`::` still opens the property picker, not emoji (coexistence)', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' ::', { delay: 30 })

    const popup = page.locator('[data-testid="suggestion-popup"]')
    await expect(popup).toBeVisible()
    // Seeded property keys appear → this is the property picker, not emoji.
    await expect(
      popup.locator('[data-testid="suggestion-item"]', { hasText: 'context' }),
    ).toBeVisible()
    // No emoji glyph leaked into the popup.
    await expect(popup).not.toContainText(JOY)
  })

  test('a bare `:` then space opens no picker', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' : ', { delay: 30 })
    await expect(page.locator('[data-testid="suggestion-popup"]')).toHaveCount(0)
  })

  test('disabling the emoji picker (Settings → Editor) stops `:` from triggering', async ({
    page,
  }) => {
    // The editor reads the preference live, so no reload is needed — the
    // next `:query` keystroke respects the flag.
    await page.evaluate(() => localStorage.setItem('agaric-emoji-picker-enabled', 'false'))
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' :joy', { delay: 30 })
    await expect(page.locator('[data-testid="suggestion-popup"]')).toHaveCount(0)
  })
})
