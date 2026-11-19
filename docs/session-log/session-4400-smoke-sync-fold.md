# Session 4400 — the sync smoke specs take in their real-binary-only neighbours

#6926 section C, row 2 and row 3: one WebdriverIO file is one app boot and one vault, so the sync specs that only the real binary can show fold into the two kept sync smoke specs as `it`s, and the folded files are deleted.

**`sync-two-device.e2e.ts`** now also runs, on the pairing its second test makes and before its restart and unpair tests:

- the seven view-refresh tests of `sync-refresh.e2e.ts` (Due, Done and Unfinished panels, the Pages list, an open page's title and tabs, `tag:#` search, the week's empty day, Last edited #6048). Its own pairing test is dropped: the pairing is the spec's.
- `property-defs-sync.e2e.ts` test 2 (the peer's `date` definition retypes a held value). Its test 3 is dropped: `e2e/property-def-undo.spec.ts` "Undo on the delete toast brings the definition back" asserts the same and is on `REAL_BACKEND_SPECS`. Its test 1 was its pairing.
- the `page-mode-sync.e2e.ts` test (#5691), less its pairing.
- the `mirror-sync.e2e.ts` test (#5363), less its pairing. It runs last of the folded tests, so no earlier test writes under a live mirror; its first pass does mirror their pages, and its `failed` / `diverged` checks now cover them too.

The three files' copies of `syncIdle`, `pullPeerWrites` and `waitInOpenView` are one copy now.

**`sync-qr-scan.e2e.ts`** takes `camera-permission.e2e.ts` and `qr-scanner-camera.e2e.ts`. Both run before the scan test, because that test replaces `MediaDevices.prototype.getUserMedia` with a canvas stream for the rest of the WebView's life; after it the camera tests would pass on the canvas. The scanner test now ends by pressing Escape and waiting for the viewfinder to go: a joiner's dialog shows no passphrase, so it closes without the "Cancel pairing?" guard, and the scan test's sidebar navigation is not blocked by the open modal.

**Trap:** `just e2e-real` fails in a cloud container at the frontend build (`define_import_meta_default.resolve is not a function` from the React Compiler Babel preset): `wdio.conf.ts`'s `onPrepare` spawns `npm run build` with WDIO's TypeScript loader in its environment. CI never meets it, as it sets `WDIO_SKIP_TAURI_BUILD=1`. Build with the same `npm run tauri -- build --debug --no-bundle …` command by hand, then run with `WDIO_SKIP_TAURI_BUILD=1`.

**Left:** `e2e-tauri/AGENTS.md`'s two-device rule still names `sync-refresh.e2e.ts`; the section F docs PR owns that file.

**Ran:** both specs with `just e2e-real` under `WDIO_SKIP_TAURI_BUILD=1`, on a binary built from this branch; `npm run typecheck:e2e-tauri`; oxlint and oxfmt over `e2e-tauri/`.
