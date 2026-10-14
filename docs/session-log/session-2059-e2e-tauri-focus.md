# Session 2059 — the real-backend lane gets a focused window (#5457)

A `/batch-issues` batch, built while the #5387 and #5399 builders ran.

### #5457

- **The bug.** Bare Xvfb has no window manager, so nothing focuses the app
  window and `document.hasFocus()` stays false in the WebKitWebView. The
  empty-block cleanup returns early on that, so the two specs that need it
  (`escape-property-line`, `attachment-only-block-survives-blur`) were skipped.
- **The fix.**
  - The lane installs openbox and starts it inside `xvfb-run`; openbox focuses
    new windows by default.
  - `waitForAppReady` waits for `document.hasFocus()` and fails with the
    reason, so a lane that loses focus reds instead of passing focus-gated
    specs vacuously.
  - Both specs are re-enabled.
- **The second cause.** With focus fixed, both controls still failed. A one-run
  diagnostic showed focus true and all four metadata probes empty for the
  surviving blank block, which was OLDER than the marked block: a blank block
  the journal holds that no focus change visits, so the cleanup never looks at
  it. The controls asserted "no blank block anywhere"; they now record the id
  of the blank block Enter put the editor in (`focusedBlankBlockId`, which
  also fails if the editor is not blank) and assert that block is gone.

### Verified

- `tsc -p tsconfig.wdio.json`, oxlint and oxfmt are clean on `e2e-tauri/`.
- Not run locally: the lane needs the native build. The PR's own run of the
  lane is the check, since the workflow file is in its path filter.
- Not done: reverting each survive-arm's fix to watch it go red. That needs a
  native-build run per revert; the controls passing is what makes the
  survive arms meaningful.
