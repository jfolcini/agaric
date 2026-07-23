// ---------------------------------------------------------------------------
// Real-backend block durability across a full view teardown (#3085).
//
// Bug class (#3082): "durable state vanishes after navigation/reload". A block
// committed to the live backend must survive the frontend tearing its tree
// down and re-querying — the classic mock-vs-real divergence, since the JS mock
// holds state in-memory and would "persist" even a write the real backend
// dropped.
//
// RELOAD-vs-NAVIGATE decision (spec 2 of #3085):
//   The task allows `browser.refresh()` IF tauri-driver supports it, else a
//   navigate-away-and-back proxy. We deliberately use the NAVIGATE proxy:
//   `browser.refresh()` under tauri-driver / WebKitWebDriver reloads the
//   WebView document, and there is a real risk it re-enters index.html WITHOUT
//   `window.__TAURI_INTERNALS__` re-injected (or drops the IPC bridge), which
//   would fail the whole app rather than test persistence — a false negative we
//   cannot pre-screen locally (the harness only runs in weekly CI). Navigating
//   to a STRUCTURALLY different view (Settings) and back fully unmounts the
//   JournalPage/BlockTree and forces a fresh backend list on return, giving the
//   same durable-read guarantee without jeopardising the IPC bridge. To keep
//   this distinct from `journal-note-crossview` (a single Journal<->Pages hop),
//   this spec routes through Settings — a non-list view that shares no tree
//   with the Journal — as the strongest in-process reload proxy available.
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

const MARKER = 'wdio-block-persist-reload'

describe('Agaric real-backend block durability (#3085)', () => {
  it('re-renders a committed block after a full Journal teardown and remount', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    // Create + commit a uniquely-marked block through the live backend.
    await addBlockWithMarker(MARKER)

    // Reload proxy: unmount the Journal entirely (Settings shares no tree with
    // it), then return. The Journal re-queries the backend on remount.
    await navigateTo('Settings')
    await navigateTo('Journal')

    // The block must render again — proof the create op was DURABLE, not just a
    // live in-memory artefact of the pre-teardown render.
    const persisted = blockStaticByMarker(MARKER)
    await persisted.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(persisted).toBeDisplayed()
  })
})
