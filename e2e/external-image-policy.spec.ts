/**
 * E2E for #1492 — external-image load policy (default Click).
 *
 * Under the default `click` policy with an empty allowlist, an external
 * `![](https://host/x.png)` must render the privacy PLACEHOLDER showing the
 * source domain — and crucially must NOT mount a real `<img src="https://…">`
 * (no `<img>` = no network request to the third party). This is the
 * app-enforced privacy guarantee that backstops the widened CSP `img-src`.
 *
 * The click → load transition (host added to the allowlist, image then loads)
 * is covered exhaustively by the GatedImage unit tests; here we assert the
 * at-rest static render in a real browser, the part the unit tests can't reach.
 *
 * Authoring path mirrors image-node.spec.ts: type the markdown, blur to
 * serialize, and the static RichContentRenderer re-parses + renders.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

// A genuinely external host (never resolved — no <img> is mounted for it under
// the default click policy, so nothing is fetched).
const EXTERNAL_URL = 'https://images.example.com/cat.png'
const EXTERNAL_HOST = 'images.example.com'

test.describe('external image policy — default click (#1492)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('an external image shows the domain placeholder, not an <img src=https…>', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type(`pic ![a cat](${EXTERNAL_URL}) done`)

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()

    // The privacy placeholder is shown with the source domain.
    const blocked = block.locator('[data-testid="image-external-blocked"]')
    await expect(blocked).toBeVisible({ timeout: 10_000 })
    await expect(block.locator('[data-testid="image-external-domain"]')).toHaveText(EXTERNAL_HOST)
    // A Load affordance exists in click mode.
    await expect(block.locator('[data-testid="image-load-button"]')).toBeVisible()

    // CRITICAL privacy property: NO real <img> carrying the external src is
    // mounted, so the third party is never contacted.
    await expect(block.locator(`img[src="${EXTERNAL_URL}"]`)).toHaveCount(0)

    // Surrounding text survived the round-trip.
    await expect(block).toContainText('pic')
    await expect(block).toContainText('done')
  })
})
