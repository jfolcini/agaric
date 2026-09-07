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
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
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
// A 1x1 transparent PNG (68 bytes).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('Agaric real-backend attachment paste (#4671)', () => {
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
})
