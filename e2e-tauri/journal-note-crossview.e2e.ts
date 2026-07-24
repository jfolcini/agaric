// ---------------------------------------------------------------------------
// Real-backend cross-view durability (#3085).
//
// Bug class (#3082): durable state must not vanish when the user switches
// primary views. This spec creates a block in the Journal, switches to the
// Pages view and back, and asserts the block is still present — a view-switch
// durable read against the REAL backend (distinct from
// `block-persist-reload`, which routes through Settings as a heavier teardown).
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  navigateTo,
  waitForAppReady,
} from './helpers'

// Marker rule (run 30057838392): NO adjacent duplicate characters — WebKit
// key handling deterministically coalesces repeated keystrokes ('ss'->'s'),
// so a marker with doubles can never be typed verbatim.
const MARKER = 'wdio-journal-viewhop'

describe('Agaric real-backend cross-view durability (#3085)', () => {
  it('keeps a Journal block after switching to Pages and back', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    await addBlockWithMarker(MARKER)

    // Switch to the Pages view (a different backend surface) and return.
    await navigateTo('Pages')
    await navigateTo('Journal')

    const persisted = blockStaticByMarker(MARKER)
    await persisted.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(persisted).toBeDisplayed()
  })
})
