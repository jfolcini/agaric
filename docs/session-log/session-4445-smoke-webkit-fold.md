# Session 4445 — the plugin and WebKitGTK smoke specs take in their neighbours

#6926 section C, rows 10 to 13: the real-binary-only specs for plugins, capabilities and WebKitGTK fold into four kept smoke specs as `it`s, and the folded files are deleted.

- **`block-clipboard`** takes `app-health` (the bug report: clipboard copy, log files, the ZIP on disk) and both `appimage-launcher-env` tests (the opener plugin under an AppImage environment). `wdio.conf.ts`'s `SPECS_IN_AN_APPIMAGE_ENV` now names `block-clipboard.e2e.ts`, so this file's app boots with the staged `APPDIR`, `LD_LIBRARY_PATH` and wrapping `xdg-open`; those touch only what the app launches.
- **`settings-desktop-integration`** takes both `journal-template-quick-capture` tests, between its autostart test and its rebind test: they press the default Quick Capture chord, which the rebind test replaces for the rest of the run.
- **`page-mode-reveal`** takes the three `markdown-reveal-persist` tests, `chip-below-edited-block`, and `gutter-alignment` as a nested suite. Mocha runs a suite's own tests before its child suites, and the gutter suite sets `--agaric-font-size` on the document for the rest of the WebView's life, so it runs last.
- **`voice-note-record`** takes `microphone-permission`, first, and the render half of `attachment-image-render`, last: a pasted PNG decodes in WebKitGTK from its stored bytes after a round trip.

**Ported to the bridge:** the storage half of `attachment-image-render` (an Edit-as-Markdown save of another line keeps the image block's ref, and the image still resolves) is a second test in `e2e/inline-image-1434.spec.ts`, on `REAL_BACKEND_SPECS`. The `read_attachment` bytes gap of #6926 section D is closed: the spec's first test already resolves bytes on the bridge. Red: with `PageSourceEditor.tsx` sending the buffer with `![` turned into `[` (a buffer that loses an image's `!`), the test fails on the image's `blob:` src after the save; restored.

**Verified against the code, not the map:**

- `app-health` was already one test on main: its counters and integrity rebuild are `e2e/app-health.spec.ts`, on the bridge. The whole file folds.
- `spaces.e2e.ts` no longer holds "titles the window": that and Move to space are `e2e/spaces-move-and-title.spec.ts`. What is left is its delete test, which #6926 section B classes portable, so it is not folded here and the file stays.

**Ran:** the four specs with `just e2e-real` under `WDIO_SKIP_TAURI_BUILD=1` (session 4400 says why), and `e2e/inline-image-1434.spec.ts` on a locally built bridge (`AGARIC_E2E_BRIDGE`). `npm run typecheck:e2e-tauri`, `npm run typecheck:e2e`, oxlint over `e2e-tauri/` and the spec. `spec-durations.json` gets estimates for the merged specs until CI measures them.

**Resumed 2026-11-25.** Parked on `claude/6926-smoke-g4-wip` when #6926 was paused on 2026-11-19, now rebased onto `main` after groups 2 and 3 (#7077, #7078). Two files had moved on `main`: `microphone-permission.e2e.ts` (one comment line, renaming its camera twin) is deleted here as before, and `spec-durations.json` takes this group's edits on `main`'s copy. The log is renumbered from 4403; the `-wip` branch is left untouched.
