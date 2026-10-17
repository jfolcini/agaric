import type { Locator, Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  focusBlock,
  focusBlockById,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the inline `:` emoji picker (#130 Phase 2).
 *
 * Verifies the headline flow (`:shortcode` → native emoji) and, critically,
 * that the new `:` trigger coexists with the existing `::` property trigger
 * and ordinary colons:
 *   - `:joy` opens the emoji picker; Enter inserts 😂 and removes `:joy`.
 *   - `::` still opens the PROPERTY picker (emoji stays dormant).
 *   - a bare `:` followed by a space opens nothing.
 *
 * Also the browse-grid picker that `/emoji` and the toolbar's Emoji button
 * open: the pick lands at the caret, focus returns to the block, and the
 * text survives a reopen. The picker must keep the editor mounted, which the
 * mock shows as well as the real backend.
 */

const JOY = '\u{1F602}'
const ROCKET = '\u{1F680}'
// SEED_IDS.BLOCK_GS_1 (src/lib/tauri-mock/seed.ts).
const GS_1 = '0000000000000000000BLOCK01'

/** Focus GS_1, make it read `Alpha Omega`, and park the caret after `Alpha `. */
async function caretBetweenWords(page: Page): Promise<Locator> {
  const editor = await focusBlockById(page, GS_1)
  await replaceEditorText(page, 'Alpha Omega')
  await selectEditorRange(page, 6, 6)
  return editor
}

/** Pick 🚀 in the open browse-grid picker; it closes on select. */
async function pickRocket(page: Page): Promise<void> {
  const picker = activeDialog(page)
  await picker.getByRole('searchbox', { name: 'Search emoji', exact: true }).fill('rocket')
  await picker.getByRole('gridcell', { name: 'rocket', exact: true }).click()
  await expect(picker).toHaveCount(0)
}

/** Leave the block, reopen the page, and read GS_1 back from the mock. */
async function expectPersisted(page: Page, text: string): Promise<void> {
  await saveBlock(page, 'Escape')
  await reopenPage(page, 'Getting Started')
  await expect(page.locator(`[data-testid="block-static"][data-block-id="${GS_1}"]`)).toHaveText(
    text,
  )
}

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

  test('`/emoji` inserts the picked emoji at the caret', async ({ page }) => {
    const editor = await caretBetweenWords(page)
    await page.keyboard.type('/emoji', { delay: 30 })
    await page.getByRole('option', { name: /^EMOJI — Insert emoji from picker/ }).click()
    await pickRocket(page)

    await expect(editor).toHaveText(`Alpha ${ROCKET}Omega`)
    await expect(editor).toBeFocused()
    await expectPersisted(page, `Alpha ${ROCKET}Omega`)
  })

  test('the toolbar emoji button inserts the picked emoji at the caret', async ({ page }) => {
    // #281 — the mouse-first twin of the `:` typeahead. The button dispatches
    // OPEN_EMOJI_PICKER, which opens the same dialog `/emoji` does.
    const editor = await caretBetweenWords(page)
    let emojiBtn = page.getByRole('button', { name: /emoji/i }).first()
    if (!(await emojiBtn.isVisible().catch(() => false))) {
      // It can sit in the overflow popover under width pressure.
      await page.getByRole('button', { name: 'More', exact: true }).click()
      emojiBtn = page.getByRole('button', { name: /emoji/i }).first()
    }
    await emojiBtn.click()
    await pickRocket(page)

    await expect(editor).toHaveText(`Alpha ${ROCKET}Omega`)
    await expect(editor).toBeFocused()
    await expectPersisted(page, `Alpha ${ROCKET}Omega`)
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
