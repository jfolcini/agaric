/**
 * E2E for #6032 — a link to an attachment, `[label](attachment:<id>)`, which
 * an import writes for a linked file or an embedded one that is not an image.
 *
 * The block shows the link as a file link, not an image and not a web link,
 * after a navigation round-trip, and a click downloads the stored file under
 * its name.
 */
import {
  expect,
  focusBlock,
  navigateToView,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

test.describe('attachment link (#6032) @attachments @editor', () => {
  test('`[label](attachment:<id>)` shows as a file link that downloads the file', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()

    const attachmentId = await page.evaluate(async () => {
      const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
      const row = (await invoke('add_attachment_with_bytes', {
        blockId: '0000000000000000000BLOCK01',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        bytes: [37, 80, 68, 70],
      })) as { id: string }
      return row.id
    })

    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type(`read [paper](attachment:${attachmentId}) now`)
    await saveBlock(page)

    await navigateToView(page, 'Journal')
    await openPage(page, 'Getting Started')
    const block = page.locator('[data-testid="sortable-block"]').first()
    const link = block.locator('[data-testid="attachment-link"]')
    await expect(link).toHaveText('paper')
    await expect(block.locator('[data-testid="external-link"]')).toHaveCount(0)

    const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
    expect(download.suggestedFilename()).toBe('paper.pdf')
  })
})
