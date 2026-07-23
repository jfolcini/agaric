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

describe('Agaric real-backend smoke (#155)', () => {
  it('boots the app, renders the Journal, and round-trips a block through the live backend', async () => {
    // 1. The app auto-loads its frontend when the WebKitWebView starts (no
    //    navigation needed). Wait for the desktop sidebar to mount — the first
    //    proof the React tree booted (BootGate resolved) against the real
    //    backend. The default window is 1024px wide, above the md breakpoint,
    //    so the sidebar is visible.
    const sidebar = await $('[data-slot="sidebar"]')
    await sidebar.waitForExist({ timeout: 60_000 })

    // 2. The Journal nav button (accessible name exactly "Journal") confirms the
    //    nav rendered. `aria/` matches by accessible name; scoping the follow-up
    //    interactions to the sidebar avoids the QuickAccessBar's like-named chip.
    const journalNav = await sidebar.$('aria/Journal')
    await journalNav.waitForDisplayed({ timeout: 30_000 })

    // 3. Add a block via the Journal daily view's "Add block" action. The
    //    button's accessible name is the "agenda.day.addBlock" label ("Add
    //    block"); `*=` matches its visible text so an icon prefix can't break it.
    const addBlock = await $('button*=Add block')
    await addBlock.waitForClickable({ timeout: 30_000 })
    await addBlock.click()

    // 4. The roving TipTap editor mounts as a contenteditable inside
    //    `[data-testid="block-editor"]` (aria-label "Block editor"). Focus it and
    //    type a unique marker so the assertion can't collide with seeded content
    //    or a previous run.
    const marker = `wdio real backend smoke ${Date.now()}`
    const editor = await $('[data-testid="block-editor"] [contenteditable="true"]')
    await editor.waitForDisplayed({ timeout: 30_000 })
    await editor.click()
    await browser.keys(marker.split(''))

    // 5. Commit the block (Enter flushes and moves the roving editor to a fresh
    //    sibling), then Escape out of that new editor.
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])

    // 6. Assert the block persisted and rendered: a committed (non-focused)
    //    block renders as StaticBlock (`data-testid="block-static"`) now
    //    containing our marker text. This only passes if the real backend
    //    accepted the create op and the frontend reprojected it.
    const persisted = await $(`[data-testid="block-static"]*=${marker}`)
    await expect(persisted).toBeDisplayed()
  })
})
