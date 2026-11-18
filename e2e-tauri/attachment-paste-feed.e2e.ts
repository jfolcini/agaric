// ---------------------------------------------------------------------------
// Real-backend: a file pasted into a block shows in that block's attachment row
// without leaving the view (#6545).
//
// The paste goes through the editor's own handler (`processFileAttachments` in
// EditableBlock.tsx -> `add_attachment_with_bytes`), which leaves the list it
// wrote to alone. The block's row (`StaticBlockAttachments`) reads the tree's
// batch attachment list, which re-reads only on `recordAttachmentInvalidation`,
// and after a local command that comes only from the backend's change feed:
// `blocks:changed` with `local_command` and the `attachments` domain. A PDF, not
// an image, so the file stays a block attachment instead of an inline node.
//
// The spec never leaves the view: the point is that it need not, so there is
// no navigation round-trip, which would re-read the list by itself.
//
// Globals (`$`, `browser`) come from @wdio/globals — see helpers.ts.
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

const MARKER = runScopedMarker('wdio-attach-feed')
const FILENAME = 'wdio-attach-feed.pdf'

describe('a file pasted into a block shows in its attachment row without leaving the view @editor @attachments', () => {
  it("lists the pasted file in the block's attachment row", async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(MARKER)

    await pasteFileIntoFocusedBlock(btoa('%PDF-1.4 wdio'), FILENAME, 'application/pdf')
    await waitForToast(`Attached "${FILENAME}"`)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const section = `[data-block-id="${await block.getAttribute('data-block-id')}"] [data-testid="attachment-section"]`

    await browser.waitUntil(
      () =>
        browser.execute(
          (sel: string, name: string) =>
            document.querySelector(sel)?.textContent?.includes(name) ?? false,
          section,
          FILENAME,
        ),
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: "the block's attachment row never listed the file pasted into it",
      },
    )
  })
})
