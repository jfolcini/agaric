/**
 * E2E for #1434 — markdown image node.
 *
 * A `![alt](url)` image must round-trip through the editor and render as an
 * `<img>` in the at-rest static view. The render happens in a real browser
 * (the static `RichContentRenderer` builds the `<img>` from the parsed node), so
 * this needs an e2e in addition to the unit render test.
 *
 * Authoring path: the roving editor parses a block's markdown on focus and
 * serializes it on blur, so typing the `![alt](url)` markdown and saving (blur)
 * drives the full parse → serialize → static-render round-trip.
 *
 * A short URL is used (not a long data URL) so the editor's per-keystroke
 * draft-autosave serialize loop stays cheap — a multi-hundred-char single line
 * stalls that loop in the harness regardless of node type. The `<img>` element
 * is asserted as ATTACHED (it exists in the DOM as soon as the static view
 * renders, before/whether or not the src resolves); the unit render test covers
 * the visual broken-image fallback on a load error.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

const IMG_URL = 'https://example.com/cat.png'

test.describe('markdown image round-trip (#1434)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('`![alt](url)` renders an <img> after save', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    // Type the image markdown verbatim; the round-trip happens on blur when the
    // block serializes to `![a cat](url)` and the static view re-parses.
    await editor.type(`pic ![a cat](${IMG_URL}) done`)

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    // The static renderer drew an <img> carrying the alt + src (attached in the
    // DOM regardless of whether the network src resolves).
    const img = block.locator('img[alt="a cat"]')
    await expect(img).toBeAttached({ timeout: 10_000 })
    await expect(img).toHaveAttribute('src', IMG_URL)
    // Surrounding text survived the round-trip.
    await expect(block).toContainText('pic')
    await expect(block).toContainText('done')
  })
})
