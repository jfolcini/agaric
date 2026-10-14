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

### Verified

- `tsc -p tsconfig.wdio.json`, oxlint and oxfmt are clean on `e2e-tauri/`.
- Not run locally: the lane needs the native build. The PR's own run of the
  lane is the check, since the workflow file is in its path filter.
