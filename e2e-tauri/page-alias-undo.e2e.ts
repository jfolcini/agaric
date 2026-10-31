// ---------------------------------------------------------------------------
// Real-backend alias undo (#5387).
//
// An alias edit is `remove_page_alias` / `add_page_alias` ops, so the page's
// Ctrl+Z reverses it through `agaric-engine/src/reverse/alias_ops.rs` and the
// reverse arms in `commands/history.rs`. Before #5387 `page_aliases` sat
// outside the op log and there was nothing to undo. The paired blocking test
// is the mock lane's `undoing an alias edit restores the aliases it replaced`
// (`src/lib/__tests__/tauri-mock.test.ts`), with the hook's undo-stack tests
// in `usePageAliases.test.ts`.
//
// Two aliases, not one: after the round trip the KEPT alias is the positive
// signal that the alias list has loaded, so the absence of the undone one is
// not read off a header that has not fetched yet. They are added seconds
// apart (each is typed through the read-back loop), so the undo stack holds
// them as two entries, not one coalesced burst.
//
// Ctrl+Z reaches `useUndoShortcuts` only with no input and no block focused,
// so "Done" closes the alias editor before it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  aliasBadge,
  blockStaticByMarker,
  clickUncovered,
  expectAbsent,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'

const MARKER = runScopedMarker('wdio-alias-undo')
const KEPT = runScopedMarker('wdio-alias-kept')
const UNDONE = runScopedMarker('wdio-alias-undone')

/** Add `alias` through the page kebab's "Add alias", then close the editor. */
async function addAlias(alias: string): Promise<void> {
  const kebab = $('button[aria-label="Page actions"]')
  await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await kebab.click()
  await clickUncovered($('[role="menuitem"]*=Add alias'), 'Add alias')
  await typeInputVerified('[aria-label="New alias input"]', alias)
  const add = $('button=Add')
  await add.waitForClickable({ timeout: ACTION_TIMEOUT })
  await add.click()
  await $(aliasBadge(alias)).waitForDisplayed({
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the alias ${alias} never showed in the header`,
  })
  const done = $('button=Done')
  await done.waitForClickable({ timeout: ACTION_TIMEOUT })
  await done.click()
}

/** Re-open the page the sidebar's "New Page" created, with nothing focused. */
async function reopenTheNewPage(): Promise<void> {
  await reopenPageByTitle('Untitled')
  await blockStaticByMarker(MARKER).waitForDisplayed({ timeout: NAV_TIMEOUT })
  await $('[data-testid="block-editor"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
}

describe('Agaric real-backend alias undo (#5387) @editor @pages', () => {
  it('removes the alias Ctrl+Z reversed, durably', async () => {
    await waitForAppReady()
    // The marker gives the page a block that survives losing focus; the
    // sidebar click commits it, and the trip back re-mounts with nothing
    // focused.
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await navigateTo('Journal')
    await reopenTheNewPage()

    await addAlias(KEPT)
    await addAlias(UNDONE)

    await browser.keys(['Control', 'z'])
    await waitForToast('Undid alias')
    await expectAbsent(aliasBadge(UNDONE), 'the undone alias, in place')
    await $(aliasBadge(KEPT)).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // The durable read: leave the page editor and come back, so the aliases
    // are the ones the backend holds, not the ones the header held.
    await navigateTo('Journal')
    await reopenTheNewPage()
    await $(aliasBadge(KEPT)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the kept alias did not come back on re-open',
    })
    await expectAbsent(aliasBadge(UNDONE), 'the undone alias, after the round trip')
  })
})
