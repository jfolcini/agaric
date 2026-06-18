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
 * A tiny inline `data:` GIF is used as the src so the image actually LOADS
 * (deterministically, no network) and the node view keeps the real `<img>`
 * mounted. An external `http(s)` URL would (a) be blocked by the Tauri CSP
 * `img-src` and (b) fail to load in CI's no-network sandbox — either way the
 * `onError` fallback would REPLACE the `<img>` with the placeholder, detaching
 * it. `data:` is short enough to keep the per-keystroke draft-autosave serialize
 * loop cheap. The unit render test covers the broken-image fallback path.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

// A short same-origin asset the dev server serves: CSP `img-src 'self'` allows
// it and it actually loads, so the real <img> stays mounted (no onError
// fallback). Short — avoids both the no-network failure of an external URL and
// the long-single-line-URL autosave loop a data: URI would trip.
const IMG_URL = '/favicon.svg'

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
    // The static renderer drew an <img> carrying the alt + src; the data: src
    // loads, so the real <img> stays mounted (no fallback swap).
    const img = block.locator('img[alt="a cat"]')
    await expect(img).toBeAttached({ timeout: 10_000 })
    await expect(img).toHaveAttribute('src', IMG_URL)
    // Surrounding text survived the round-trip.
    await expect(block).toContainText('pic')
    await expect(block).toContainText('done')
  })
})
