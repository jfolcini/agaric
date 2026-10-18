/**
 * E2E for #1492 — external-image load policy: the default Click placeholder,
 * and each option of the Settings › Editor select (#5733).
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
import type { Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  openSettingsTab,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

// A genuinely external host (never resolved — no <img> is mounted for it under
// the default click policy, so nothing is fetched).
const EXTERNAL_URL = 'https://images.example.com/cat.png'
const EXTERNAL_HOST = 'images.example.com'

test.describe('external image policy — default click (#1492) @attachments @settings', () => {
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

// A 1x1 transparent PNG, served for EXTERNAL_URL so the policy tests below load
// a real image without touching the network.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

async function setImagePolicy(page: Page, option: string): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  await chooseSelectOption(page, 'External images', option)
}

test.describe('external image policy — Settings › Editor select (#5733) @attachments @settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(EXTERNAL_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }),
    )
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await replaceEditorText(page, `pic ![a cat](${EXTERNAL_URL}`)
    // The typed closing paren fires the image input rule.
    await page.keyboard.type(') done')
    await saveBlock(page)
    await expect(page.getByTestId('image-external-blocked')).toBeVisible()
  })

  test('Always load mounts the <img>; Ask each time brings the placeholder back', async ({
    page,
  }) => {
    const block = page.locator('[data-testid="sortable-block"]').first()

    await setImagePolicy(page, 'Always load')
    await openPage(page, 'Getting Started')
    const img = block.locator(`img[src="${EXTERNAL_URL}"]`)
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)

    await setImagePolicy(page, 'Ask each time (recommended)')
    await openPage(page, 'Getting Started')
    await expect(block.getByTestId('image-external-domain')).toHaveText(EXTERNAL_HOST)
    await expect(block.getByTestId('image-load-button')).toBeVisible()
  })

  test('Never load shows the blocked placeholder with no Load button', async ({ page }) => {
    const block = page.locator('[data-testid="sortable-block"]').first()

    await setImagePolicy(page, 'Never load')
    await openPage(page, 'Getting Started')
    await expect(block.getByTestId('image-external-domain')).toHaveText(EXTERNAL_HOST)
    await expect(block.getByTestId('image-external-blocked-note')).toBeVisible()
  })
})
