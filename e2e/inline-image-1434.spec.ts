/**
 * E2E for #1434 — inline image stored as an attachment + attachment-ref render.
 *
 * The image paste/drop path stores the bytes as an attachment and inserts an
 * inline image node whose `src` is an internal `attachment:<id>` ref. On render
 * the static `RichContentRenderer` (via `GatedImage`) must resolve that ref back
 * to the attachment's bytes — reading them over IPC and mounting a `blob:` URL
 * `<img>`. Driving a real OS clipboard image paste in Playwright is brittle, so
 * this exercises the equivalent observable path:
 *
 *   1. Seed an attachment WITH bytes via the same IPC the paste handler calls
 *      (`add_attachment_with_bytes`) and capture its backend-minted id.
 *   2. Author a block whose markdown is `![alt](attachment:<id>)` (exactly what
 *      the paste handler inserts) and blur to drive parse → serialize → render.
 *   3. Assert the at-rest view drew an `<img alt>` whose `src` is a resolved
 *      `blob:` object URL — i.e. the ref round-tripped through markdown AND
 *      resolved to the stored bytes.
 *
 * A tiny 1x1 transparent GIF is used as the bytes so `<img>` actually decodes
 * and stays mounted (no broken-image fallback swap).
 */
import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { attachFile, expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

// 1x1 transparent GIF.
const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
)

test.describe('inline image attachment-ref (#1434) @attachments @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('`![alt](attachment:<id>)` resolves the stored bytes to a blob <img>', async ({ page }) => {
    // Seed the attachment through the IPC the paste handler uses, before the page shows the
    // block, and build the ref from the backend-minted id.
    const { id: attachmentId } = await attachFile(
      page,
      SEED_IDS.BLOCK_GS_1,
      'pasted.gif',
      'image/gif',
      GIF_1X1,
    )
    expect(attachmentId).toMatch(/^[0-9A-Za-z]+$/)
    await openPage(page, 'Getting Started')
    // The badge comes with its own read; the click into the block aims at its finished layout.
    await expect(
      page.locator('[data-testid="sortable-block"]').first().getByTestId('attachment-badge'),
    ).toBeVisible()

    // Author the inline image markdown the paste handler would have inserted.
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially(`pic ![a cat](attachment:${attachmentId}) done`)

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    const img = block.locator('img[alt="a cat"]')
    await expect(img).toBeAttached({ timeout: 10_000 })
    // The ref resolved to the stored bytes → a blob: object URL, not the literal
    // `attachment:` ref.
    await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 10_000 })
    // Surrounding text survived the markdown round-trip.
    await expect(block).toContainText('pic')
    await expect(block).toContainText('done')
  })
})
