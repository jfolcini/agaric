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
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

// 1x1 transparent GIF, as a byte array (what add_attachment_with_bytes expects).
const GIF_1X1: number[] = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

test.describe('inline image attachment-ref (#1434)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('`![alt](attachment:<id>)` resolves the stored bytes to a blob <img>', async ({ page }) => {
    // Seed the attachment with bytes via the SAME IPC the paste handler uses,
    // and read back the backend-minted id to build the ref.
    const attachmentId = await page.evaluate(async (bytes) => {
      const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
      const row = (await invoke('add_attachment_with_bytes', {
        blockId: '0000000000000000000BLOCK01',
        filename: 'pasted.gif',
        mimeType: 'image/gif',
        bytes,
      })) as { id: string }
      return row.id
    }, GIF_1X1)

    expect(attachmentId).toMatch(/^[0-9A-Za-z]+$/)

    // Author the inline image markdown the paste handler would have inserted.
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type(`pic ![a cat](attachment:${attachmentId}) done`)

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
