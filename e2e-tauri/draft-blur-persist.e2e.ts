// ---------------------------------------------------------------------------
// Real-backend uncommitted text survives leaving the view (#4671).
//
// Drafts are waived from conformance. Typing arms `useDraftAutosave` (a 2 s
// `save_draft` debounce), and leaving the block without Enter or Escape goes
// through `useEditorBlur`: `edit_block` with the live content, then
// `delete_draft`. A block that shows its text only while its editor is
// mounted, and comes back empty after the view unmounts, is the failure this
// guards. No in-app gesture leaves a draft ROW to be restored later — every
// navigation commits through blur, and `flush_all_drafts` only runs at boot
// (useAppBootRecovery) — so this is the blur-save half of the draft story;
// the boot-recovery half needs a process kill the harness cannot drive.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openJournalBlockEditor,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const MARKER = runScopedMarker('wdio-draft-blur')

describe('Agaric real-backend draft blur-save (#4671)', () => {
  it('keeps text that was typed but never committed with Enter after a view round-trip', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(MARKER)

    // No Enter, no Escape: the sidebar click is the only exit.
    await navigateTo('Pages')
    await navigateTo('Journal')

    const persisted = blockStaticByMarker(MARKER)
    await persisted.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(persisted).toBeDisplayed()
  })
})
