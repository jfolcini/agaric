# Session 4160 — Engine follow-ups: the dirty mark follows the write, boot replay fans out per chunk, a shed reference reindex is retried, and the review notes of the sweep

Set out to close what #6765, #6766 and #6767 found and left, and the non-blocking review notes of #6721, #6726, #6735, #6738, #6765, #6766, #6767 and #6768, in one PR ahead of stage B of #6521.

## What shipped

- **A `for_space` guard marks its space dirty when it is dropped.** `for_space` marked before it took the engine lock. A snapshot pass whose collect fell between the mark and the write exported the engine without the write and cleared the flag, and a restart lost the write from the engine (decision 5 of the #6521 comment on #6765). The guard now carries a `MarkDirtyOnDrop` field declared after the lock guard, so the mark comes after the unlock and the dirty lock is still never nested in an engine lock. #6767's delta holds the write, but boot does not read `loro_doc_delta` until stage B, so the fix is needed now.
- **Boot replay hands each chunk's fan-out to one `dispatch_commit`.** Per op, a 450-op replay shed 688 tasks and left 278 of 450 blocks searchable after a flush.
- **`ReindexFtsReferences` has a retry kind.** A rename whose fan-out a full queue shed left every block naming the page or tag indexed under its old name until that block's next edit. `RemoveFtsBlock` still has none and needs none: the delete and purge commands remove the cohort's rows themselves after the commit, and search never returns a row whose block is deleted or gone.
- Review notes: `lowest_saved_watermark` is one query; the `is_write_contention` forwarder in `maintenance.rs` and the three test-only `dispatch_*_background` wrappers are gone; `prepare_outgoing` warns and still exports when its stamp delta cannot be saved; `saveBlob` returns the saved name and the Markdown-file toast uses it, so a second save on macOS names the numbered file.

## Declined, with the reason

- #6765, `revert_entries` marking an evicted engine's space: needs a space purge between a transaction's first touch and its rollback, and costs one empty snapshot pass a tick until restart.
- #6767, a why-comment on `mirror_sql_tombstones_onto_engine` committing before its error: the comment is already there ("saved for what was written even when a later tombstone failed").
- #6726, moving the Android toast out of `saveBlob` so the four `!isAndroid()` guards go: the diagram and attachment saves have no toast of their own, so each would need an Android-only one, and a caller that forgot it would leave Android silent. `save_to_downloads` already returns the final name (#6721's note); only `saveBlob` dropped it.
- #6735, a failed bridge reset leaving no vault open: the bridge is test-only and the reset's reply already carries the boot error; the reviewer's own verdict.
- #6768, rcgen's dev-dependency weight: a committed certificate expires and needs a private-key exclusion; nothing is in the way today.
- #6738, `flush_background` firing the #2935 debounce early: the `after_rebuild` event promises settled caches, and a pending delete's rebuild is part of that; the cost is one early rebuild in a delete-then-property-write burst.
- `AGARIC_E2E_BACKGROUND_DELAY_MS` stays. It does not stand in for an overrun queue but for a rebuild that outlasts the week view's re-read, which takes some 4,500 dated blocks in a debug build and depends on the runner's speed. Without it `agenda-count-after-write.e2e.ts` stays green with its fix reverted, so a green run without the knob shows nothing. The real-backend lane could not run on the session's box (no `WebKitWebDriver`, `tauri-driver` or `openbox`).

## Traps

- A test of the mark's order cannot race two threads into the gap: the pass blocks on the engine lock the writer holds. The test takes the pass's cut of the dirty set while the guard is held, writes, drops, then clears with the cut's stamps.
- `flush_background` does not run shed tasks (only `settle_background` does), so the replay test fails on both the shed counter and the row count.
- A full queue is still reachable after #6766: `enqueue_inbound_sync_rebuilds` enqueues up to four tasks a block for a quarter of the queue's capacity in blocks.

## Suites run

`cargo nextest run --workspace` in two halves on the final code (4,089 of 4,089 and 4,083 of 4,083 passed, none on a retry), `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `just gen-sqlx`. Frontend: the vitest files of every `saveBlob` caller (401 tests), `npm run typecheck`, and Playwright `e2e/page-kebab.spec.ts`. Each new test was shown red first: items 1 to 3 and the two behaviour-changing review notes each failed on the assertion predicted before the fix went in. Not run: the whole vitest and Playwright suites, doc-tests, the manual-stage hooks and WebdriverIO (the box has no `WebKitWebDriver`); CI's runs are the check.

PR: the one on `claude/engine-followups-2026-11-14`.
