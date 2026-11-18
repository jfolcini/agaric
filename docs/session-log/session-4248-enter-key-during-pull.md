# Session 4248 — a key typed right after Enter while a pull reloads the page

#6814: while a peer's edits were pulled in, the key after an Enter could reach `<body>`. The open question was whether the reload after the pull or a refused Sync press's toast took the focus. It was the reload.

`createPageBlockStore().load()` waited for in-flight creates, splits and merges (`heldBlocks`, #6559) only before it asked for its snapshot. When a sync's `reloadChangedPageStores` asked first and Enter's command started while the snapshot was on its way, the snapshot landed without the block Enter had made (and, for a split, with the source text whole). Applying it dropped the provisional row, so the roving editor unmounted and the next key went nowhere: every symptom in the issue, down to "block 250 whole again, no editor open".

Fix: `hold` moved from the reducers to `page-blocks.ts`, which owns the load generation, and counts the holds it takes. A load that sees the count move while its snapshot was in flight reads again (after waiting for the holds). Every tree on the page store gets it: journal day, week and the page editor. Page mode's single editor already reads again when a reload overlaps one of its saves (`save.writes` in `PageModeEditor.tsx`), and an Enter there unmounts nothing.

Not built here: #6811's maintainer comment asks for a deterministic Rust sync simulation with this bug as one seeded case. This race is in the frontend store, which no Rust simulation can reach, so the simulation stays with #6811.

## Tests

- `src/stores/__tests__/page-blocks.split-merge.test.ts`: a reload asked before `splitOff` and answered after it keeps both halves shown throughout. Red without the fix (the new block went missing).
- `e2e-tauri/enter-during-pull.e2e.ts`: pairs `e2e_sync_peer`, opens a page the peer wrote, has the peer edit it and the app pull. Every read of the page asked before Enter is answered 3 s late, with the snapshot taken when it was asked, and Enter is pressed while one is on its way. The wrapper sits on `window.fetch`: Tauri's `__TAURI_INTERNALS__.invoke` is read-only, so a wrapper assigned there silently does nothing. It has to delay every read, not only the first: the pull reloads the page on `sync:complete` and again on `blocks:changed`, and the newer load's generation discards the older one, so with only the first read late the spec passed on `main`. The focus must still be in the editor once the read lands, and the key typed then must be in the new block after a nav round-trip. The Sync press is a script click, which leaves the focus in the editor.

## What ran

- `npx vitest run src/stores src/editor src/hooks/__tests__/useSyncEvents*`: green. The new store test was red without the fix.
- `just e2e-real`-equivalent runs (local Xvfb, the debug app built by `npm run tauri -- build --debug --no-bundle …`, then `WDIO_SKIP_TAURI_BUILD=1 scripts/e2e-tauri-local.sh`): `enter-during-pull` red on `main`'s store (`Expected: "editor"`, `Received: "BODY"`), green three times with the fix. `sync-refresh`, `sync-ref-to-new-block` and `page-mode-sync` green with the fix.
- Playwright (mock): `reload-keeps-editor`, `enter-split-caret`, `journal-add-block-while-editing`, `enter-after-caret-key`, `editor-lifecycle`: 43 passed.
- `just lint`, `npm run typecheck`, `npm run typecheck:e2e-tauri`.

Trap: `just e2e-real` failed here before reaching the spec, because the Tauri build spawned from WDIO's `onPrepare` breaks vite's React Compiler preset (`define_import_meta_default.resolve is not a function`), while the same `npm run build` run by hand works. Building first and running with `WDIO_SKIP_TAURI_BUILD=1` works around it.
