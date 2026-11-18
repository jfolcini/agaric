# Session 4363 — review notes batch

Recheck every review note, blocking and non-blocking, on the 67 PRs merged between 2026-11-17 18:30 UTC and 2026-11-18 (#6877–#6958), against main. Every review was an approval and none left a blocking note open. Each note is now either addressed on main, covered by work in flight (#6956; #6540 slice B for #6948's two notes), let go with a reason, or fixed here. The fixes ride on #6956's branch with its own batch (session 4342), so both take one CI run; the full table is in #6956's body.

**Fixed here:**
- `e2e-tauri/spec-durations.json` drops all 23 entries whose spec no longer exists, more than #6940, #6954 and #6957 named. The file was edited by hand, because `scripts/e2e-tauri-durations.mjs` reads Actions logs through `gh api`, which this session could not call.
- `PagePropertyTable.tsx` loses the FE-H-17 comment over `definitions` (#6951). The copy over the rows fetch's error effect still describes that code, so it stays.
- `bulk-pages-history-order.test.ts`: the `undo_page_op` case could not fail. `undo_page_op` reads one page's ops and each bulk page has one, so push order never reached it (noted in #6956's body). Bulk Page 001 now gets a second, older stamp pushed after its newer one. Shown red with the handler trusting push order: it reversed the older op (`expected 10 to be 7`).
- `e2e/toolbar-controls.spec.ts`: one comment line rewrapped at 100 columns (#6933).
- #6962's four notes, which merged after the audit: the search specs' `byCode` comparator was the default string order and is gone; `search-shown-text-6277`'s `expectFound` and `search-results`' `expectListed` are one `expectSearchListed` in `e2e/helpers.ts`; the #6741 group-by test no longer boots twice; and `spec-durations.json` drops the seven WDIO specs #6962 deleted.

**Let go, not obvious:** #6939's `files_under` reads file text it only prints on failure. It is test-only with no failure, and fixing it would put a `.rs` file in this batch, which runs the cargo lanes in CI for nothing.

**Ran:** the three changed search and query spec files on the mock (16 passed, 1 skipped) and on the bridge (20 passed, 1 skipped); vitest over `src/lib/tauri-mock/__tests__/bulk-pages-history-order.test.ts` and `src/components/pages`, `npm run typecheck`, oxlint and oxfmt on the touched files.
