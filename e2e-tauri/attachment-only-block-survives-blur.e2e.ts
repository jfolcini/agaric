// ---------------------------------------------------------------------------
// Real-backend: a blank block whose only content is an attachment survives
// leaving it (#5364).
//
// `/voice`, `/attach` and a non-image paste all put the attachment on the
// block without touching its text, so the drop-on-blur cleanup
// (`src/lib/empty-block-cleanup.ts`) saw a blank, metadata-free block and
// soft-deleted it, recording and all. No mock-backed suite ever attached a
// file to a BLANK block. The control arm runs first: a bare blank block IS
// dropped, which proves the cleanup ran under this driver at all (it stands
// down whenever `document.hasFocus()` is false). Then the attachment-only
// block, which must still list its file after a navigation round-trip.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  pasteFileIntoFocusedBlock,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-attach-only')
const FILENAME = 'wdio-attach-only.txt'
// "hello" — a non-image file stays a plain block attachment, so the block's
// text is untouched (an image would also land as an inline node).
const TXT_BASE64 = 'aGVsbG8='

const EDITOR = '[data-testid="block-editor"]'

/** Enter at the end of the focused block mints a blank sibling; returns its id. */
async function openBlankBlockBelow(previousId: string): Promise<string> {
  await browser.keys(['End'])
  await browser.keys(['Enter'])
  await browser.waitUntil(
    async () => (await $(EDITOR).getAttribute('data-block-id')) !== previousId,
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'Enter did not move the editor to a new block' },
  )
  return $(EDITOR).getAttribute('data-block-id')
}

describe('Agaric real-backend attachment-only block (#5364)', () => {
  it('keeps a blank block that holds an attachment, and still drops a bare one', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(MARKER)
    const markerId = await $(EDITOR).getAttribute('data-block-id')

    // Control arm: a bare blank block is dropped when the user leaves it.
    const bareId = await openBlankBlockBelow(markerId)
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await expectAbsent(`[data-block-id="${bareId}"]`, 'the bare blank block')

    // The block under test: blank text, one attachment.
    await blockStaticByMarker(MARKER).click()
    await $(`${EDITOR}[data-block-id="${markerId}"]`).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const attachedId = await openBlankBlockBelow(markerId)
    await pasteFileIntoFocusedBlock(TXT_BASE64, FILENAME, 'text/plain')
    await waitForToast(`Attached "${FILENAME}"`)
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const row = $(`[data-block-id="${attachedId}"]`)
    await row.waitForExist({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the attachment-only block was dropped by the leave-the-block cleanup',
    })
    // The badge's count comes from the `list_attachments_batch` the remounted
    // BlockTree issued, so it is the re-queried durable read.
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
