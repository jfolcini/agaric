// ---------------------------------------------------------------------------
// Real-backend edit-then-return text persistence (#3085).
//
// Bug class (#3082): an EDIT to existing durable text (not just a create) must
// survive a navigation round-trip against the real backend. This exercises the
// `editBlock` IPC path — separate from the create path the other specs cover —
// and guards against a mock-vs-real divergence where an in-place text edit
// reprojects fine in memory but is not actually written.
//
// Flow: create + commit a block, RE-ENTER it (clicking a StaticBlock calls
// `onFocus` -> mounts the roving TipTap editor: StaticBlock.tsx
// `handleOuterClick`), append a distinct suffix at the end of the line, commit,
// then navigate away and back and assert the COMBINED text is present.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  navigateTo,
  waitForAppReady,
} from './helpers'

const BASE = 'wdio-edit-base'
const SUFFIX = '-edited'

describe('Agaric real-backend edit persistence (#3085)', () => {
  it('persists an in-place text edit across a navigation round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // 1. Create + commit the base block.
    await addBlockWithMarker(BASE)

    // 2. Re-enter edit mode by clicking the committed block; the roving editor
    //    mounts with its text. Move to end of the line and append the suffix.
    const staticBlock = blockStaticByMarker(BASE)
    await staticBlock.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await staticBlock.click()

    const editor = $('[data-testid="block-editor"] [contenteditable="true"]')
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['End'])
    await browser.keys(SUFFIX.split(''))
    // Commit the edit (Enter flushes editBlock + moves the roving editor on),
    // then Escape out of the fresh sibling editor.
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // 3. The edited block re-renders with the combined text.
    const combined = `${BASE}${SUFFIX}`
    const editedStatic = blockStaticByMarker(combined)
    await editedStatic.waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // 4. Navigate away and back — the durable read.
    await navigateTo('Pages')
    await navigateTo('Journal')

    // 5. The combined, edited text must still be present — proof the edit was
    //    durably written, not just an in-memory reprojection.
    const persisted = blockStaticByMarker(combined)
    await persisted.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(persisted).toBeDisplayed()
  })
})
