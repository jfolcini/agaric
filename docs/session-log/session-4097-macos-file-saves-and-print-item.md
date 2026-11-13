# Session 4097 — macOS file saves go through the backend; *Print…* in the page menu

Two items built without the hardware that can confirm them, on the maintainer's decision of 2026-11-13: code that needs a Mac or a Windows PC to verify merges now, and the hardware checks move to #6514 and #6515 as checklist lines. One PR, #6652 and the last box of #6558.

## File saves on macOS (#6652)

The premise was read again in wry 0.57.0 before building: `wkwebview/navigation.rs::navigation_policy` answers `Cancel` to a download navigation when `has_download_handler` is false, and nothing in `src-tauri` registers one. So on macOS every `<a download>` click saved nothing while the toast said saved.

Two fixes were possible. Registering `on_download` is small in Rust, but the main window comes from `tauri.conf.json`, which has no hook for it, so the window would have to be built in code on every platform, and whether WKDownload then saves a `blob:` URL is exactly what cannot be run here. The other is a command that writes the bytes, which is plain file I/O and tests on Linux. That one shipped: `save_to_downloads` (`src-tauri/src/commands/downloads.rs`) writes into the Downloads folder under a new name, numbering a taken one (`notes (1).md`) and never overwriting.

The frontend had two anchor-download helpers, `downloadBlob` in `export-graph.ts` and `triggerDownload` in `attachment-utils.ts`. They are now one: `saveBlob` in `attachment-utils.ts`, which `triggerDownload` wraps for raw bytes; `downloadBlob` is gone. It is async and rejects on failure, and every caller awaits it before its success toast. That is the place the Android save path (#6546) belongs too: its branch replaces the "saving is unavailable" notice at the top of `saveBlob`. No such branch existed on the remote when this was built.

Linux and Windows keep the anchor download. The only change there: the export, bug-report and Markdown-file saves now revoke the object URL a tick later, as attachment saves already did (#2275).

Traps:

- `isMac()` is true in a Mac browser running the mock, where `save_to_downloads` is a no-op. Nobody develops this app on a Mac today; if that changes, the mock handler is where a browser download goes.
- The bytes cross IPC as base64 (`Base64Bytes`, the upload shape), so a large export is held about twice in memory on macOS.
- A test that spies `navigator.platform` must restore the spy and reset the platform cache, or the next test in the file takes the macOS branch.

## Print (#6558)

The print stylesheet was already on `main` (#6621). This added what the box still lacked:

- *Print…* in the page kebab, absent on Android. It calls `window.print()`. On macOS Tauri replaces `window.print` with a call to its own `plugin:webview|print` command, which needs `core:webview:allow-print`; that permission is not in `core:webview:default`, so it was added to the desktop capability. Without it the item would do nothing on a Mac.
- Block mode prints a long page whole: `useViewportObserver` treats no row as off screen between `beforeprint` and `afterprint`, and flushes that synchronously, because a print lays the page out as `beforeprint` returns.
- A heading stays with what follows it, and an external link prints its address after its text. A bare URL therefore prints twice; CSS cannot tell a label from its address.

Trap: under Playwright's print emulation the scroll boxes lose their fixed height, every row intersects, and the observer fills the rows in by itself over a few frames. A spec that waits for the rows passes with the `beforeprint` code removed. The spec reads the placeholder count in the same task that dispatches `beforeprint`.

## What ran

- Rust: `cargo nextest run --workspace` in two halves, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx` and `just gen-bindings` with no further diff.
- Frontend: full vitest, `npm run typecheck`, `npm run lint`, `prek run --hook-stage manual --all-files`.
- Playwright: `e2e/print-page.spec.ts` and the specs nearest the change (page kebab, import and export, attachments, bug report, perf). `just e2e-related` selects the whole of both lanes for this diff (a mock handler and `bindings.ts` changed), so CI's run is the check for the rest. `e2e/diagram-legibility.spec.ts` fails two tests in this container on a clean `origin/main` as well (a label measured at 10.99994 px against a floor of 11).
- Each new or changed path was broken once and its test seen red on the predicted assertion.

Not run, and not runnable here: anything on macOS or Windows. The checks are on #6514 and #6515.
