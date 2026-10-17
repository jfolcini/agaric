// ---------------------------------------------------------------------------
// Real-backend redo, History revert and point-in-time restore (#4671).
//
// The history commands are waived from mock conformance, so their effect on
// the real op log is proven only here. One file, one vault: the three cases
// share it, each on its own titled page, and restore runs last because the
// History view restores the whole space (`restore_page_to_op('__all__', …)`,
// HistoryRestoreDialog) and would also sweep any case that ran after it.
//
// Edits commit by blur (a sidebar click), never Enter + Escape, whose
// throwaway sibling would add a create and a delete to the op log the
// History cases read.
//
// UI paths: History is opened from Settings › Data › "Open edit history"
// (DataTab.tsx); it lists every op of the space newest first, one
// `[data-history-item]` row each (HistoryListItem.tsx) with an op-type
// `history-type-badge` and the op's new text in `.history-item-preview`.
// A row's checkbox feeds "Revert selected" (HistorySelectionToolbar) and its
// "Reset to this point" button opens the restore dialog; both confirm in a
// `[role="alertdialog"]` (ConfirmDialog).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  confirmDialog,
  enterBlankSibling,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

/** Selector of the committed block rows whose text contains `marker`. */
function staticSelector(marker: string): string {
  return `[data-testid="block-static"]*=${marker}`
}

/** Leave the page editor; the sidebar click blurs, and so commits, the open block. */
async function commitByLeaving(): Promise<void> {
  await navigateTo('Journal')
}

/** Re-open `title` and wait until `marker`'s block is shown with nothing focused. */
async function reopenQuiet(title: string, marker: string, what: string): Promise<void> {
  await reopenPageByTitle(title)
  await blockStaticByMarker(marker).waitForDisplayed({ timeout: NAV_TIMEOUT, timeoutMsg: what })
  // Page-level Ctrl+Z / Ctrl+Y are no-ops while a block is focused.
  await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

/** Replace the text of the block holding `from` with `to`, then commit it by leaving. */
async function replaceBlockText(from: string, to: string): Promise<void> {
  await blockStaticByMarker(from).click()
  const editor = $(EDITOR)
  await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  await editor.click()
  await browser.keys(['Control', 'a'])
  await browser.keys(['Delete'])
  await typeMarkerVerified(to)
  await commitByLeaving()
}

/** Settings › Data › "Open edit history", ready once the entries grid shows. */
async function openEditHistory(): Promise<void> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await dataTab.click()
  const open = $('[data-testid="settings-panel-data"]').$('button*=Open edit history')
  await open.waitForClickable({ timeout: ACTION_TIMEOUT })
  await open.click()
  await $('[role="grid"][aria-label="History entries"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The History row of the `edit_block` op that set a block's text to `marker`. */
async function editRow(marker: string) {
  const row = $(
    '//*[@data-history-item]' +
      '[.//*[@data-testid="history-type-badge"][normalize-space(.)="edit_block"]]' +
      `[.//*[contains(@class, "history-item-preview")][contains(normalize-space(.), "${marker}")]]`,
  )
  await row.waitForDisplayed({
    timeout: NAV_TIMEOUT,
    timeoutMsg: `History never listed the edit that wrote ${marker}`,
  })
  return row
}

/** The marked block's task checkbox, resolved through its row wrapper. */
async function taskMarker(marker: string) {
  const staticBlock = blockStaticByMarker(marker)
  await staticBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const blockId = await staticBlock.getAttribute('data-block-id')
  const checkbox = $(`[data-block-id="${blockId}"]`).$('[data-testid="task-marker"]')
  await checkbox.waitForExist({ timeout: NAV_TIMEOUT })
  return checkbox
}

/**
 * Wait until the checkbox reports (or stops reporting) a stored todo state:
 * "Task: {{state}}. Click to cycle." replaces "Set as TODO" once one is set
 * (BlockInlineControls `TaskMarkerButton`).
 */
async function expectTodoState(marker: string, set: boolean, what: string): Promise<void> {
  const checkbox = await taskMarker(marker)
  await browser.waitUntil(
    async () => ((await checkbox.getAttribute('aria-label')) ?? '').startsWith('Task:') === set,
    { timeout: NAV_TIMEOUT, timeoutMsg: what },
  )
}

describe('Agaric real-backend history: redo, revert, restore (#4671)', () => {
  it('re-applies the todo state Ctrl+Y redid, durably', async () => {
    const page = runScopedMarker('wdio-redo-page')
    const marker = runScopedMarker('wdio-redo-task')
    await waitForAppReady()
    await openNewPage(page)
    await typeMarkerVerified(marker)
    // The round trip also puts seconds between the block's ops and the
    // checkbox's, so the 500 ms undo group holds the checkbox op alone.
    await commitByLeaving()
    await reopenQuiet(page, marker, 'the typed block did not come back on re-open')

    const checkbox = await taskMarker(marker)
    await checkbox.moveTo()
    await checkbox.click()
    await expectTodoState(marker, true, 'the task checkbox never reported a set todo state')

    await browser.keys(['Control', 'z'])
    await waitForToast('Undid property change')
    await expectTodoState(marker, false, 'undo did not clear the todo state in place')

    // `redoLastUndoneOp` is "Ctrl + Y / Ctrl + Shift + Z" (keyboard-config/catalog.ts).
    await browser.keys(['Control', 'y'])
    await waitForToast('Redid property change')
    await expectTodoState(marker, true, 'redo did not restore the todo state in place')

    await commitByLeaving()
    await reopenQuiet(page, marker, 'the redone block did not come back on re-open')
    await expectTodoState(marker, true, 'the redone todo state was gone on re-open')
  })

  it('reverts one edit from the History view and keeps the other, durably', async () => {
    const page = runScopedMarker('wdio-revert-page')
    const first = runScopedMarker('wdio-revert-first')
    const reverted = runScopedMarker('wdio-revert-second')
    const kept = runScopedMarker('wdio-revert-kept')
    await waitForAppReady()
    await openNewPage(page)
    await typeMarkerVerified(first)
    await commitByLeaving()
    await reopenQuiet(page, first, 'the first text did not come back on re-open')

    // The edit to revert, then a later edit on a second block, so reverting
    // the newest op instead of the chosen one shows.
    await replaceBlockText(first, reverted)
    await reopenQuiet(page, reverted, 'the edit to revert did not come back on re-open')
    await blockStaticByMarker(reverted).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await enterBlankSibling()
    await typeMarkerVerified(kept)
    await commitByLeaving()

    await openEditHistory()
    const row = await editRow(reverted)
    const select = row.$('button[role="checkbox"]')
    await select.waitForClickable({ timeout: ACTION_TIMEOUT })
    await select.click()
    const revertSelected = $('button*=Revert selected')
    await revertSelected.waitForClickable({ timeout: ACTION_TIMEOUT })
    await revertSelected.click()
    await confirmDialog('Revert')
    // The toolbar leaves only on success: a failed revert keeps the selection.
    await revertSelected.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the revert did not succeed: the selection toolbar stayed',
    })

    await reopenPageByTitle(page)
    await blockStaticByMarker(first).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the reverted edit did not roll back: the text before it never came back',
    })
    await blockStaticByMarker(kept).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the edit left alone did not survive the revert',
    })
    await expectAbsent(staticSelector(reverted), 'the reverted edit')
  })

  it('restores the page to a point in its history, durably', async () => {
    const page = runScopedMarker('wdio-restore-page')
    const before = runScopedMarker('wdio-restore-one')
    const atPoint = runScopedMarker('wdio-restore-two')
    const after = runScopedMarker('wdio-restore-third')
    const created = runScopedMarker('wdio-restore-new')
    await waitForAppReady()
    await openNewPage(page)
    await typeMarkerVerified(before)
    await commitByLeaving()
    await reopenQuiet(page, before, 'the first text did not come back on re-open')

    await replaceBlockText(before, atPoint)
    await reopenQuiet(page, atPoint, 'the restore point did not come back on re-open')
    await replaceBlockText(atPoint, after)
    await reopenQuiet(page, after, 'the later edit did not come back on re-open')
    await blockStaticByMarker(after).click()
    await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await enterBlankSibling()
    await typeMarkerVerified(created)
    await commitByLeaving()

    await openEditHistory()
    const row = await editRow(atPoint)
    const reset = row.$('button[aria-label="Reset to this point"]')
    await reset.waitForClickable({ timeout: ACTION_TIMEOUT })
    await reset.click()
    await confirmDialog('Restore')
    await waitForToast('reverted successfully')

    await reopenPageByTitle(page)
    await blockStaticByMarker(atPoint).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the edit at the restore point is gone after the restore',
    })
    await expectAbsent(staticSelector(after), 'the edit after the restore point')
    await expectAbsent(staticSelector(created), 'the block created after the restore point')
  })
})
