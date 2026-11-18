/**
 * E2E for #6032 — a link to an attachment, `[label](attachment:<id>)`, which
 * an import writes for a linked file or an embedded one that is not an image.
 *
 * The block shows the link as a file link, not an image and not a web link,
 * after a navigation round-trip, and a click downloads the stored file under
 * its name.
 */
import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  attachFile,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

test.describe('attachment link (#6032) @attachments @editor', () => {
  test('`[label](attachment:<id>)` shows as a file link that downloads the file', async ({
    page,
  }) => {
    await waitForBoot(page)
    // Before the page shows the block, so its attachment row is drawn before the click into it.
    const { id: attachmentId } = await attachFile(
      page,
      SEED_IDS.BLOCK_GS_1,
      'paper.pdf',
      'application/pdf',
      '%PDF',
    )
    await openPage(page, 'Getting Started')
    // The badge comes with its own read; the click into the block aims at its finished layout.
    await expect(
      page.locator('[data-testid="sortable-block"]').first().getByTestId('attachment-badge'),
    ).toBeVisible()

    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially(`read [paper](attachment:${attachmentId}) now`)
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
