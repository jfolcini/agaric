// ---------------------------------------------------------------------------
// Real-backend page-level undo (#4671).
//
// Undo/redo are waived from conformance ("NOT cross-checked"), so the reverse
// path (agaric-engine/src/reverse/block_ops.rs: `reverse_create_block` emits
// a soft DeleteBlock) is only proven here. Ctrl+Z reaches `useUndoShortcuts`
// only in the page editor with no block focused, so the page comes from the
// sidebar's "New Page" and the undone block is the one "Add block" creates:
// its create op is the LAST op on the page (Escape on it neither commits nor
// deletes — PageEditor's `createBelow` path is not in `justCreatedBlockIds`),
// so a single Ctrl+Z reverses exactly that create. The row count is asserted
// after re-opening the page from the Pages list, the durable read.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-undo-keep')
const ROW = '[data-testid="sortable-block"]'

async function rowCount(): Promise<number> {
  return (await $$(ROW).getElements()).length
}

describe('Agaric real-backend undo (#4671)', () => {
  it('removes the block whose create Ctrl+Z reversed, durably', async () => {
    await waitForAppReady()
    // A fresh page auto-creates and focuses its first block; type a marker so
    // the page has one row that must SURVIVE the undo.
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(async () => (await rowCount()) === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the empty sibling Enter created was not removed by Escape',
    })

    const addBlock = $('button*=Add block')
    await addBlock.waitForClickable({ timeout: ACTION_TIMEOUT })
    await addBlock.click()
    await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })
    await browser.keys(['Escape'])
    await browser.waitUntil(async () => (await rowCount()) === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Add block did not add a second row',
    })
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    await browser.keys(['Control', 'z'])
    await waitForToast('Undid create block')
    await browser.waitUntil(async () => (await rowCount()) === 1, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'undo did not remove the row in place',
    })

    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await rowCount()).toBe(1)
    await expect(blockStaticByMarker(MARKER)).toBeDisplayed()
  })
})
