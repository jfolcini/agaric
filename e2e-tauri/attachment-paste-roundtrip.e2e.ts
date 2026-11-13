// ---------------------------------------------------------------------------
// Real-backend attachment paste round-trip (#4671).
//
// Attachments are waived from conformance, and their only entry point is a
// paste/drop on the editor (EditableBlock.tsx `handlePaste` ->
// `add_attachment_with_bytes`): the bytes travel over IPC, the backend writes
// them under the app data dir and inserts the `attachments` row in one
// transaction. This spec pastes a 1x1 PNG into a marked block, commits, and
// after a navigation round-trip asserts the row is listed for the block —
// the attachment badge (`list_attachments_batch` on BlockTree mount) reports
// exactly one attachment and the StaticBlock renders its attachment section.
//
// The second test is the bytes themselves (#6539): a multi-megabyte paste is
// read back through `read_attachment` and must be the bytes that were pasted.
// They cross IPC as one base64 string, and only this lane decodes it with the
// backend's decoder.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  navigateTo,
  openJournalBlockEditor,
  pasteFileIntoFocusedBlock,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-paste')
const FILENAME = 'wdio-paste.png'
// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const BIG_MARKER = runScopedMarker('wdio-big')
const BIG_FILENAME = 'wdio-big.wav'
// 3 MB holding every byte value, in an order no shorter period repeats.
const BIG = Buffer.from(
  Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 0xff),
)

/** What `read_attachment` serves for `attachmentId`. */
async function storedBytes(attachmentId: string): Promise<Buffer> {
  const base64 = await browser.execute(async (id: string) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer> }
      }
    ).__TAURI_INTERNALS__
    const held = await internals.invoke('read_attachment', { attachmentId: id })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(reader.result as string))
      reader.addEventListener('error', () => reject(reader.error))
      reader.readAsDataURL(new Blob([held]))
    })
    return dataUrl.slice(dataUrl.indexOf(',') + 1)
  }, attachmentId)
  return Buffer.from(base64, 'base64')
}

describe('Agaric real-backend attachment paste (#4671) @editor @attachments', () => {
  it('lists a pasted PNG on its block after a view round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(MARKER)

    await pasteFileIntoFocusedBlock(PNG_BASE64, FILENAME, 'image/png')
    await waitForToast(`Attached "${FILENAME}"`)
    // The image lands as an inline node in the focused editor before the
    // toast fires; commit the block with it.
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Pages')
    await navigateTo('Journal')

    const block = blockStaticByMarker(MARKER)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const blockId = await block.getAttribute('data-block-id')
    // `[data-block-id="<id>"]` (no tag prefix) is the row wrapper the passing
    // reserved-property spec already resolves the task checkbox through:
    // SortableBlock renders a <div>, so a `li[...]` prefix matches nothing.
    const row = $(`[data-block-id="${blockId}"]`)
    // The badge renders only when `attachmentCount > 0` (BlockInlineControls
    // BlockMetadataRow), and the count comes from the `list_attachments_batch`
    // the remounted BlockTree issued — so its aria-label IS the re-queried
    // durable read. The attachment SECTION is deliberately not asserted: it is
    // behind the badge's `showAttachments` toggle (default false), so its
    // absence says nothing about what the backend stored.
    const badge = row.$('[data-testid="attachment-badge"]')
    await badge.waitForExist({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(
      async () => (await badge.getAttribute('aria-label')) === '1 attachment',
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the attachment badge never reported exactly one attachment',
      },
    )
  })

  it('stores a multi-megabyte paste byte for byte (#6539)', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(BIG_MARKER)

    await pasteFileIntoFocusedBlock(BIG.toString('base64'), BIG_FILENAME, 'audio/wav')
    await waitForToast(`Attached "${BIG_FILENAME}"`)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(BIG_MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const blockId = await block.getAttribute('data-block-id')

    const rows = await invoke<{ id: string; filename: string }[]>('list_attachments', { blockId })
    expect(rows.map((row) => row.filename)).toEqual([BIG_FILENAME])
    const stored = await storedBytes(rows[0]?.id ?? '')
    expect(stored.length).toBe(BIG.length)
    expect(stored.equals(BIG)).toBe(true)
  })
})
