// ---------------------------------------------------------------------------
// Real-backend page-level undo (#4671).
//
// Undo/redo are waived from conformance ("NOT cross-checked"), so the reverse
// path (agaric-engine/src/reverse/) is only proven here. Ctrl+Z reaches
// `useUndoShortcuts` only in the page editor with NO block focused, so the
// page comes from the sidebar's "New Page" and the reversed action is the
// task checkbox — one `set_todo_state` IPC, one `set_property` op, and the
// last op on the page by a wide margin, so a single Ctrl+Z targets exactly
// it (`handleToggleTodo` pushes a ref-less entry, which Ctrl+Z resolves
// through the positional `undoPageGroup` fallback).
//
// WHY NOT undoing a block CREATE, which this spec used to attempt: an empty
// block cannot survive losing focus. BlockTree's #4729 leaked-empty-block
// cleanup deletes it on focus-leave — with `undoable: false`, so the delete
// is invisible to the undo stack too — which is why run 34065136247 saw the
// "Add block" row never reach the tree ("Add block did not add a second
// row"). Giving the block content instead makes the last op an `edit_block`,
// not the create. The checkbox is the one gesture whose single op IS the
// last op, and its effect is readable straight off the DOM.
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
  await staticBlock.waitForExist({ timeout: NAV_TIMEOUT })
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
async function waitForTodoState(
  marker: Awaited<ReturnType<typeof taskMarker>>,
  set: boolean,
  what: string,
): Promise<void> {
  await browser.waitUntil(
    async () => ((await marker.getAttribute('aria-label')) ?? '').startsWith('Task:') === set,
    { timeout: NAV_TIMEOUT, timeoutMsg: what },
  )
}

describe('Agaric real-backend undo (#4671)', () => {
  it('clears the todo state Ctrl+Z reversed, durably', async () => {
    await waitForAppReady()
    // A fresh page auto-creates and focuses its first block; commit a marker
    // into it so the durable read has something to address the block by.
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    // Escape drops the empty sibling Enter opened, and unmounts the roving
    // editor — which is also the precondition for Ctrl+Z below
    // (`useUndoShortcuts` bails while `focusedBlockId` is set).
    await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })

    const marker = await taskMarker()
    await marker.moveTo()
    await marker.click()
    await waitForTodoState(marker, true, 'the task checkbox never reported a set todo state')

    await browser.keys(['Control', 'z'])
    await waitForToast('Undid property change')
    await waitForTodoState(await taskMarker(), false, 'undo did not clear the todo state in place')

    // The durable read: leave the page editor entirely and re-open the page
    // from the Pages list, so the state comes back from the backend.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    const after = blockStaticByMarker(MARKER)
    await after.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await waitForTodoState(await taskMarker(), false, 'the undone todo state came back on re-open')
  })
})
