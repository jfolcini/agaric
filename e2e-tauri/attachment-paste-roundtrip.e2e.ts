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
    const row = $(`li[data-block-id="${blockId}"]`)
    const badge = row.$('[data-testid="attachment-badge"]')
    await badge.waitForExist({ timeout: NAV_TIMEOUT })
    expect(await badge.getAttribute('aria-label')).toBe('1 attachment')
    const section = row.$('[data-testid="attachment-section"]')
    await section.waitForExist({ timeout: NAV_TIMEOUT })
    await expect(section).toBeExisting()
  })
})
