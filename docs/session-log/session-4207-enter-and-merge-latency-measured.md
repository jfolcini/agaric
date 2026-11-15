# Session 4207 — How long Enter and merge wait on the real backend

Built #6559's last box: measure the Enter and merge window through the app, on desktop, and leave the phone half on #6513.

**What shipped.** `e2e-tauri/enter-merge-latency.e2e.ts`, opt-in like `page-mode-save-cost.e2e.ts` (`AGARIC_PERF=1 just e2e-real …`, skipped otherwise): 100 Enter splits and 100 Backspace merges on block 250 of a 2,000-block page, idle and while `e2e_sync_peer` rewrites its own page and the app pulls it, then five 300-line page-mode pastes, each undone with one Ctrl+Z. The times are the app's own: with debug mode on, `logLatencySample` (`src/lib/latency-sample.ts`) logs one line per Enter or merge, from the key's handler to the block's focus and to the backend's answer, which the spec reads back from the app's log and a phone's logcat shows. `placeCaret` and `materializerIdle` moved to `e2e-tauri/helpers.ts`. Numbers and the go / no-go are in `docs/architecture/operations.md` § Enter and merge through the app.

**The 100K vault did not fit the lane.** The first build seeded 100K blocks in the app: the seed took 19 minutes and the materializer 27 more in the debug build, before a single sample. The sync half was worse: `e2e_sync_peer`'s pairing is a pull of the app's vault, which it waits 60 s for; serving a pull makes the peer pull back what the app holds (`peer_holds_news`, #6551), so whichever way they pair the peer ends up indexing the whole vault on the same CPU. The spec uses the issue's 2,000-block page beside one 1,000-block page; the backend's 100K probe (`bench_enter_split_and_merge`, #6706/#6712) stays the other half.

**Traps.**
- Off-screen rows render as placeholder `li`s, and the Pages list is alphabetical and paged at 50: the target row is scrolled in before it is waited on, and the page's title sorts first.
- A local write's own pull waits for a 2 s pause (`LOCAL_EDIT_DEBOUNCE`), which keys pressed one after another never leave, so under sync the spec presses the sidebar Sync button from the page (`click()` moves no focus).
- A frozen peer (`pause()`) holds a session open until a transport timeout; the app's writes stalled behind it.
- With a peer paired before the seed, the app's first 1,000-block batch outlasted WebDriver's timeout; that and the pulled vault's slowness are #6811.
- The reconciliation oracle, run while a slow `create_blocks_batch` was still in its transaction, reported engine nodes with no SQL row. That was not data loss: given time the paste landed and the oracle was clean.

**Found and filed, not fixed (out of scope).**
- #6810: after Enter in the middle of a block, the caret lands at the end of the new block, so the next keys go after the moved text (reproduced on the mock lane too).
- #6811: writes are far slower on a vault pulled from a peer (split about 2 s, a 300-line paste 91 s, debug, 3K blocks) and with a peer paired before them (a 1,000-block batch past WebDriver's timeout). First filed as an SQL/engine divergence; corrected the same session.
- #6814: under sync a key typed right after an Enter reached nothing (focus on `<body>`) in three of six runs, never idle. The spec counts such a key (`lost_keys`) and presses it again, so one does not end a run; a key lost twice still does.

**Ran.** The spec six times locally (`just e2e-real` with `AGARIC_PERF=1`, about 5 minutes each), after a 100K attempt and a dozen small-vault dry runs; the numbers are in `operations.md`; `npx vitest run src/lib/__tests__/latency-sample.test.ts src/components/block-tree/__tests__/` and `npx vitest run e2e-tauri`; `npm run typecheck`; `node --test scripts/e2e-related.test.mjs`. The three call-site tests and two of the helper's were each shown red by one mutation.
