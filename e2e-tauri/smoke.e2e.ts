// ---------------------------------------------------------------------------
// Real-backend smoke test (issue #155).
//
// Runs against the REAL Agaric binary in a WebKitWebView via tauri-driver, so
// every step here exercises the genuine Rust backend over real Tauri IPC — NOT
// the JS mock the Playwright `e2e/` suite uses. It is the canary for the weekly
// lane: if the app boots, the frontend renders, and a block round-trips through
// the live backend, the harness itself is healthy.
//
// Selectors are deliberately resilient and reuse the app's real testids /
// accessible names (the same ones the Playwright specs and `e2e/helpers.ts`
// rely on): `[data-slot="sidebar"]`, the "Journal" nav button, the "Add block"
// action, `[data-testid="block-editor"]` (contenteditable, aria-label
// "Block editor"), and `[data-testid="block-static"]` committed rows (a
// non-focused block renders as StaticBlock; `sortable-block` is only a CSS
// class on the row wrapper, NOT a testid).
// ---------------------------------------------------------------------------

// `browser`, `$`, and `expect` are provided as globals by @wdio/globals at
// runtime (typed via @wdio/globals/types in tsconfig.wdio.json).

import { dismissWelcomeModalIfPresent, openJournalBlockEditor, typeMarkerVerified } from './helpers'

describe('Agaric real-backend smoke (#155)', () => {
  it('boots the app, renders the Journal, and round-trips a block through the live backend', async () => {
    // 1. The app auto-loads its frontend when the WebKitWebView starts (no
    //    navigation needed). Wait for the desktop sidebar to mount — the first
    //    proof the React tree booted (BootGate resolved) against the real
    //    backend. The default window is 1024px wide, above the md breakpoint,
    //    so the sidebar is visible.
    const sidebar = await $('[data-slot="sidebar"]')
    await sidebar.waitForExist({ timeout: 60_000 })

    //    First boot shows the modal onboarding dialog (WelcomeModal.tsx) which
    //    aria-hides the app root and intercepts every click — dismiss it
    //    before interacting (live-run 30052635297 root cause).
    await dismissWelcomeModalIfPresent()

    // 2. The Journal nav button confirms the nav rendered. Resolve it with a
    //    subtree-scoped XPath (leading `.`, honoured by WDIO relative to the
    //    sidebar) matching the `<button>` whose label `<span>` is exactly
    //    "Journal" (AppSidebar.tsx renderNavItem). We deliberately do NOT use
    //    `aria/Journal`: WDIO's accessible-name selector matches document-wide
    //    and would also match the Journal VIEW's `<h1>` (feature-page-header.tsx
    //    renders the `t('sidebar.journal')` title as an `<h1>` — same accessible
    //    name as the nav button) or the QuickAccessBar chip. This was the #155
    //    first-live-run nav defect; see helpers.ts for the full rationale.
    const journalNav = await sidebar.$('.//button[.//span[normalize-space(.)="Journal"]]')
    await journalNav.waitForDisplayed({ timeout: 30_000 })

    // 3. Add a block via the Journal daily view's first-block CTA. On a vault
    //    that already has today's page this is the "Add block" action
    //    (agenda.day.addBlock); on a VIRGIN vault (no page yet) it is the
    //    empty-state "Add your first block" CTA (journal.addFirstBlock) — both
    //    call the same handler and end with a mounted, focused roving editor.
    //    `openJournalBlockEditor` matches either and leaves the editor focused.
    await openJournalBlockEditor()

    // 4. Type a unique marker into the focused roving TipTap editor, verifying
    //    read-back so a dropped keystroke (the live WebKit editor drops
    //    characters under a janky first render) doesn't commit corrupt text and
    //    fail the marker assertion. Hyphenate so a dropped space can't merge
    //    words — the marker is still unique via the timestamp.
    const marker = `wdio-real-backend-smoke-${Date.now()}`
    await typeMarkerVerified(marker)

    // 5. Commit the block (Enter flushes and moves the roving editor to a fresh
    //    sibling), then Escape out of that new editor.
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // 6. Diagnostics probe (#155 harness hardening): before the strict marker
    //    assert, log how many editor vs. committed (static) block rows exist.
    //    This makes a failure at step 7 self-diagnosing — 0 static rows means
    //    the block never committed through the live backend; a static row
    //    present but without our marker means "committed, text mismatch".
    const staticBlocks = await $$('[data-testid="block-static"]')
    const editorBlocks = await $$('[data-testid="block-editor"]')
    console.warn(
      `[smoke probe] block-static=${staticBlocks.length} block-editor=${editorBlocks.length} marker=${JSON.stringify(marker)}`,
    )

    // 7. Assert the block persisted and rendered: a committed (non-focused)
    //    block renders as StaticBlock (`data-testid="block-static"`) now
    //    containing our marker text. This only passes if the real backend
    //    accepted the create op and the frontend reprojected it.
    const persisted = await $(`[data-testid="block-static"]*=${marker}`)
    await expect(persisted).toBeDisplayed()
  })
})
