# Session 4402 — the restart and daemon smoke specs take in their neighbours

#6926 section C, rows 6 to 9: the real-binary-only specs that restart the app or wait on a daemon fold into four kept smoke specs as `it`s, and the folded files are deleted.

- **`mirror-outbound`** takes `mirror-copy-files`, as a second test on the folder the first one set and left with a finished pass, so the copy test no longer sets a folder of its own.
- **`editor-durability`** takes `page-mode-restart` (its page now has a title, since `reopenPageByTitle('Untitled')` is ambiguous in a shared vault), the restart half of `tag-color-synced`, and `compaction-restart`. The compaction ages and purges every op in the vault, so it runs last.
- **`snapshot-restore`** takes `sync-quarantine` and `sync-quarantine-toast`, after its restore test. The retry case runs first: it expects one quarantined row and seeds `inbox_id` 1. The toast case empties `loro_sync_quarantine` in the same pre-boot write that seeds its inbox slot, so the row its *Review* lands on can only be its own, as in its own vault before.
- **`reminder-due-task`** takes `daily-snapshot`, first, on the vault boot left.

**Verified against the code, not the map:** the nav half of `tag-color-synced` was already on the bridge: `e2e/tag-management.spec.ts` "keeps a tag colour with localStorage cleared, after leaving the view" (on `REAL_BACKEND_SPECS`) asserts it. The folded restart test keeps the localStorage clear before the restart that the nav half used to make; without it, boot could read the colour back from localStorage and pass with the property broken.

`conformance-coverage.test.ts`'s waiver for `readmit_quarantined_sync_slot` named the deleted spec; it now names `snapshot-restore.e2e.ts (via seedQuarantinedDelta)`, since the spec reaches the command through the Retry button, not by name.

**Ran:** each of the four with `just e2e-real` under `WDIO_SKIP_TAURI_BUILD=1` (session 4400 says why): all green. `npx vitest run src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`, `npm run typecheck:e2e-tauri`, oxlint over `e2e-tauri/`. `spec-durations.json` gets estimates for the merged specs until CI measures them.
