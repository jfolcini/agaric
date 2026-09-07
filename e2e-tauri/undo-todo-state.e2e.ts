// ---------------------------------------------------------------------------
// Real-backend page-level undo (#4671).
//
// Undo/redo are waived from conformance ("NOT cross-checked"), so the reverse
// path (agaric-engine/src/reverse/) is only proven here. Ctrl+Z reaches
// `useUndoShortcuts` only in the page editor with NO block focused, so the
// page comes from the sidebar's "New Page" and the reversed action is the
// task checkbox — one `set_todo_state` IPC, one `set_property` op, whose
// effect is readable straight off the checkbox's `aria-label`.
//
// TIMING IS LOAD-BEARING, and is why the block is committed by navigating
// away rather than with Enter+Escape. `handleToggleTodo` pushes a REF-LESS
// undo entry, so Ctrl+Z resolves it through the positional `undoPageGroup`
// fallback, which reverts every op within `UNDO_GROUP_WINDOW_MS` (500 ms) of
// the newest one. In run 34088762135 the Escape that dropped the empty
// Enter-sibling landed inside that window, so the one Ctrl+Z also reversed
// that `delete_block` and the page fell out from under the spec ("block not
// in current space" → the page editor healed the stale reference and bounced
// to Journal). The Journal round-trip below puts seconds between the block's
// own ops and the checkbox's, so the group holds the checkbox op alone — and
// it doubles as the blur that commits the text (`draft-blur-persist`).
//
// WHY NOT undoing a block CREATE, which this spec used to attempt: an empty
// block cannot survive losing focus. BlockTree's #4729 leaked-empty-block
// cleanup deletes it on focus-leave — with `undoable: false`, so the delete
// is invisible to the undo stack too — which is why run 34065136247 saw the
// "Add block" row never reach the tree ("Add block did not add a second
// row"). Giving the block content instead makes the last op an `edit_block`,
// not the create.
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

const MARKER = runScopedMarker('wdio-undo-todo')

/** Resolve the marked block's task checkbox through its row wrapper. */
async function taskMarker() {
  const staticBlock = blockStaticByMarker(MARKER)
  await staticBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const blockId = await staticBlock.getAttribute('data-block-id')
  const marker = $(`[data-block-id="${blockId}"]`).$('[data-testid="task-marker"]')
  await marker.waitForExist({ timeout: NAV_TIMEOUT })
  return marker
}

/**
 * Wait until the checkbox's aria-label reports (or stops reporting) a set
 * todo state. `block.setTodo` ("Set as TODO") is the state-less label;
 * `block.taskCycle` ("Task: {{state}}. Click to cycle.") replaces it once a
 * state is stored (BlockInlineControls `TaskMarkerButton`).
 */
async function expectTodoState(set: boolean, what: string): Promise<void> {
  const marker = await taskMarker()
  await browser.waitUntil(
    async () => ((await marker.getAttribute('aria-label')) ?? '').startsWith('Task:') === set,
    { timeout: NAV_TIMEOUT, timeoutMsg: what },
  )
}

/** Re-open the page the sidebar's "New Page" created, with nothing focused. */
async function reopenTheNewPage(): Promise<void> {
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
  // Ctrl+Z is a no-op while a block is focused — in-editor history owns it.
  await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend undo (#4671)', () => {
  it('clears the todo state Ctrl+Z reversed, durably', async () => {
    await waitForAppReady()
    // A fresh page auto-creates and focuses its first block; the sidebar
    // click commits the typed marker by blurring the editor, and the trip
    // back re-mounts the page with nothing focused.
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await navigateTo('Journal')
    await reopenTheNewPage()

    const marker = await taskMarker()
    await marker.moveTo()
    await marker.click()
    await expectTodoState(true, 'the task checkbox never reported a set todo state')

    await browser.keys(['Control', 'z'])
    await waitForToast('Undid property change')
    await expectTodoState(false, 'undo did not clear the todo state in place')

    // The durable read: leave the page editor entirely and come back, so the
    // state is the one the backend reprojected, not the one the store held.
    await navigateTo('Journal')
    await reopenTheNewPage()
    await expectTodoState(false, 'the undone todo state came back on re-open')
  })
})
