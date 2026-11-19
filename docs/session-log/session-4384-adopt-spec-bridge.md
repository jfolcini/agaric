# Session 4384 — the folder-adoption spec moves to the bridge, where its folder pick can be answered

Fixes the real-backend `mirror-adopt` spec that has never passed (#6540). Session 4379 added it as `e2e-tauri/mirror-adopt.e2e.ts` and left it to `e2e-tauri-gate`; its shard failed on its first run, and the PR merged the same second, so it never went green there.

The spec stubbed the native folder picker by assigning `window.__TAURI_INTERNALS__.invoke`, but in the Tauri app that property is defined by tauri's `scripts/core.js` with `Object.defineProperty(window.__TAURI_INTERNALS__, 'invoke', { value: … })`, which makes it non-writable (as `ipc.js` does `ipc` and `ipc-protocol.js` does `postMessage`), so the assignment silently did nothing. The real `pick_mirror_folder` then opened the GTK folder dialog, as the product should on that click, and WebDriver waited on the click into *Open a folder of notes…* until its timeout; no WDIO spec can stub a native picker this way.

The fix ports the spec to the Playwright bridge as `e2e/mirror-adopt.spec.ts`, `@real-only` and listed in `REAL_BACKEND_SPECS`. There `__TAURI_INTERNALS__.invoke` is the mocks' writable one, so a `page.evaluate` stub answers `pick_mirror_folder` with the spec's folder and passes every other command to the real backend. The scenario is the original's: the folder imported through the card, the dialog listing `diagram.png` as left alone, the adoption leaving every file on disk as it was, the card read back after navigating away and back, and an edited block rewriting only its own line. The import's progress `Channel` is not carried by the bridge; the flow needs only the command's result, which is. The WDIO spec is deleted.

## What ran

- The bridge built with `cargo build -p agaric-diagnostics --features bridge --bin bridge`, and the spec on it, `--project=real-backend`: green.
- Red once: `mirror::adopt` made to write each file the preview lists as left alone; the spec failed at `expect(filesOnDisk(folder)).toEqual(NOTES)` on `diagram.png`, then passed again on the restored source. The same write over the plan's `.md`-only `left_alone` map stayed green, since this folder leaves no Markdown file unmapped.
- Without the stub, the spec fails within the assertion timeout at the dialog's left-alone list instead of hanging.
- `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, `npx oxlint e2e/mirror-adopt.spec.ts`, `node --test scripts/e2e-related.test.mjs`, `prek run --files` over the changed files.
