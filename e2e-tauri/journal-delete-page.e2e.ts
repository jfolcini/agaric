// ---------------------------------------------------------------------------
// Real-backend journal Delete page (#5358).
//
// The day header's Delete page soft-deleted today's page and its blocks, but
// the day kept rendering them until the app was reloaded. This spec deletes
// the page through the UI and asserts the day drops to its empty state at
// once, then that the block stays gone after a nav round-trip.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  expectAbsent,
  navigateTo,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-journal-delete-page')
const MARKED_BLOCK = `[data-testid="block-static"]*=${MARKER}`

describe('Agaric real-backend journal Delete page (#5358)', () => {
  it('empties today as soon as its page is deleted', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await addBlockWithMarker(MARKER)

    // The daily view puts the page quick actions beside "Open in editor"
    // (DaySection); the trash button is named by `pageHeader.deletePage`.
    const deletePage = $('button[aria-label="Delete page"]')
    await deletePage.waitForClickable({ timeout: ACTION_TIMEOUT })
    await deletePage.click()
    const confirm = $('[role="alertdialog"]').$('button*=Delete page')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()

    // No reload and no navigation: the empty state replaces the deleted blocks.
    await $('h2*=No blocks for').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await expect($('button*=Add your first block')).toBeDisplayed()
    await expectAbsent(MARKED_BLOCK, 'the block of the deleted page')

    // Durable: arriving back on today may auto-create a fresh page, never the deleted one.
    await navigateTo('Pages')
    await navigateTo('Journal')
    await $(
      './/button[contains(normalize-space(.), "Add block") or ' +
        'contains(normalize-space(.), "Add your first block")]',
    ).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(MARKED_BLOCK, 'the block of the deleted page after a round-trip')
  })
})
