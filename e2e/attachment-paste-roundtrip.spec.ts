import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  pasteFile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #4671, #6539 — a pasted file is stored for its block.
 *
 * Attachments enter only through a paste or drop on the editor (`add_attachment_with_bytes`): the
 * bytes cross IPC and the backend writes them and their `attachments` row together. A pasted PNG
 * is listed on its block after the page is reopened, through the badge the reopened tree counts
 * from `list_attachments_batch`. A multi-megabyte paste is read back through `read_attachment` and
 * must be the bytes that were pasted: they cross IPC as one base64 string, and only the bridge
 * decodes it with the backend's decoder.
 */

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
// 3 MB holding every byte value, in an order no shorter period repeats.
const BIG = Buffer.from(
  Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 0xff),
)

/** Create page `title` holding one line, open it, and focus the line's editor. */
async function editLineOn(page: Page, title: string, line: string): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content: line,
    parentId: pageId,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  await openPage(page, title)
  await focusBlockById(page, id)
  return id
}

/**
 * What `read_attachment` serves for `attachmentId`, read as `readAttachment` (`ipc-helpers.ts`)
 * reads it: an `ArrayBuffer` from Tauri, an array of numbers through the bridge.
 */
async function storedBytes(page: Page, attachmentId: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (id) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer | number[]>
        }
      }
    ).__TAURI_INTERNALS__
    const held = await internals.invoke('read_attachment', { attachmentId: id })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(reader.result as string))
      reader.addEventListener('error', () => reject(reader.error))
      reader.readAsDataURL(new Blob([new Uint8Array(held)]))
    })
    return dataUrl.slice(dataUrl.indexOf(',') + 1)
  }, attachmentId)
  return Buffer.from(base64, 'base64')
}

test.describe('Attachment paste (#4671) @editor @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('lists a pasted PNG on its block after the page is reopened', async ({ page }) => {
    const id = await editLineOn(page, 'Pasted image page', 'a line with a picture')
    await pasteFile(page.locator('[data-testid="block-editor"]'), {
      name: 'paste.png',
      type: 'image/png',
      base64: PNG_BASE64,
    })
    await expect(page.getByText('Attached "paste.png"')).toBeVisible()
    // The image goes into the focused editor's text; leaving the block saves it with it.
    await page.keyboard.press('Escape')

    await reopenPage(page, 'Pasted image page')
    await expect(
      page.locator(`[data-block-id="${id}"] [data-testid="attachment-badge"]`),
    ).toHaveAttribute('aria-label', '1 attachment')
  })

  test('stores a multi-megabyte paste byte for byte (#6539)', async ({ page }) => {
    const id = await editLineOn(page, 'Pasted recording page', 'a line with a recording')
    await pasteFile(page.locator('[data-testid="block-editor"]'), {
      name: 'big.wav',
      type: 'audio/wav',
      base64: BIG.toString('base64'),
    })
    await expect(page.getByText('Attached "big.wav"')).toBeVisible()

    const rows = await ipc<Array<{ id: string; filename: string }>>(page, 'list_attachments', {
      blockId: id,
    })
    expect(rows.map((row) => row.filename)).toEqual(['big.wav'])
    const stored = await storedBytes(page, rows[0]?.id ?? '')
    expect(stored.length).toBe(BIG.length)
    expect(stored.equals(BIG)).toBe(true)
  })
})
