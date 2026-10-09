// ---------------------------------------------------------------------------
// Real-backend: a blank block whose only content is an attachment is not an
// empty block (#5412).
//
// Leaving a blank block runs the empty-block cleanup (`empty-block-cleanup.ts`,
// BlockTree's focus-change effect), which soft-deletes it with
// `{ undoable: false }` unless something marks it as content. A non-image
// file pasted into a fresh block adds an `attachments` row and no text, so
// before #5412 the attachment went to Trash with its block the moment the
// user clicked away.
//
// Two arms in one vault (a second `it` sees the first one's data). The
// CONTROL leaves a blank block with nothing in it and asserts the cleanup
// removed it: that is what proves the cleanup runs under this exact sequence
// (`document.hasFocus()` true in the WebView, the delete landing before the
// round-trip), so the second arm cannot pass by the cleanup never firing.
// The second arm pastes a text file into the blank block an Enter created,
// clicks back onto the marked block above it, and after a navigation
// round-trip asserts the blank block is still listed with its one attachment
// (`list_attachments_batch` on the remounted BlockTree).
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

const CONTROL_MARKER = runScopedMarker('wdio-blank-control')
const MARKER = runScopedMarker('wdio-attach-only')
const FILENAME = 'wdio-note.txt'
// "agaric" — a text file stays a block attachment; an image would be inlined
// into the block's text and make it non-blank.
const TXT_BASE64 = 'YWdhcmlj'
// A committed blank block renders StaticBlock's placeholder span in place of
// content (StaticBlock.tsx); a block with text never does.
const BLANK_STATIC = '[data-testid="block-static"] .block-placeholder'

/** Every attachment badge on screen, with the block row it sits in. */
async function attachmentBadges(): Promise<
  Array<{ blockId: string | null; label: string | null }>
> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="attachment-badge"]')].map((badge) => ({
      blockId: badge.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      label: badge.getAttribute('aria-label'),
    })),
  )
}

/**
 * Type `marker` into a fresh journal block and press Enter, leaving the
 * roving editor in a new, blank sibling below it.
 */
async function markedBlockThenBlankSibling(marker: string): Promise<void> {
  await navigateTo('Journal')
  await openJournalBlockEditor()
  await typeMarkerVerified(marker)
  await browser.keys(['Enter'])
}

/**
 * Leave the blank block without typing: focus moves to the marked block,
 * which is what runs the cleanup on the block left behind. Returns the marked
 * block's id.
 */
async function leaveBlankBlockFor(marker: string): Promise<string | null> {
  const marked = blockStaticByMarker(marker)
  await marked.waitForClickable({ timeout: ACTION_TIMEOUT })
  const markedId = await marked.getAttribute('data-block-id')
  await marked.click()
  await browser.keys(['Escape'])
  return markedId
}

// Skipped until the lane's window has focus (#5457): the cleanup is gated on
// `document.hasFocus()`, which is false here, so the control case cannot pass and
// the survive case would pass without the cleanup ever running.
describe.skip('Agaric real-backend attachment-only block (#5412)', () => {
  it('control: the same sequence cleans up a blank block holding nothing', async () => {
    await waitForAppReady()
    await markedBlockThenBlankSibling(CONTROL_MARKER)
    await leaveBlankBlockFor(CONTROL_MARKER)

    // The cleanup's delete is optimistic, so the row leaves the DOM as soon as
    // the metadata probes resolve; wait for that before the round-trip, or
    // the navigation could unmount the tree under the probes.
    await expectAbsent(BLANK_STATIC, 'the blank control block')

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(CONTROL_MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(BLANK_STATIC, 'the blank control block')
  })

  it('keeps a blank block holding an attachment after focus leaves it', async () => {
    await markedBlockThenBlankSibling(MARKER)

    await pasteFileIntoFocusedBlock(TXT_BASE64, FILENAME, 'text/plain')
    await waitForToast(`Attached "${FILENAME}"`)

    const markedId = await leaveBlankBlockFor(MARKER)

    // Blurred, the holder renders static with its badge; that read and the
    // cleanup's probes were issued by the same focus change.
    await browser.waitUntil(async () => (await attachmentBadges()).length === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the attachment badge did not appear on the blurred block',
    })

    await navigateTo('Pages')
    await navigateTo('Journal')

    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await browser.waitUntil(
      async () => {
        const badges = await attachmentBadges()
        const [only] = badges
        return (
          badges.length === 1 &&
          only?.label === '1 attachment' &&
          only.blockId !== null &&
          only.blockId !== markedId
        )
      },
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the blank block holding the attachment did not survive leaving it',
      },
    )
  })
})
