# Session 4072 — compaction purges nothing after a failed engine save; audit notes closed

`Refs #6518`. Finishes what the review-comment audit of 2026-11-13 (the "## Audit" comment on #6667) left open after #6699.

## The compaction guard

#6666 made compaction save the engines before it purges, because the purge also deletes ops above the apply cursor. Both callers dropped the save's result. A pass that left a dirty engine unwritten therefore still purged, and a kill before the next good snapshot left those ops in neither the op log nor `loro_doc_state`.

- `save_engines_and_advance_cursor` returns the `SavePass` that `save_all_engines` already computed, instead of its count. `persisted_through` is `None` when an export or a write failed, or the registry changed under the pass.
- `commands::compaction::save_engines_then_compact` is the one path to the purge for the History card's command and the daily job. It returns `AppError::Snapshot` and purges nothing when `persisted_through` is `None`.
- A pass whose engines were written but whose background queue did not drain, or whose cursor did not move, still compacts: the engine state is on disk, which is what the purge needs.
- With a save that keeps failing, the daily job now fails each tick instead of once a day, and a vault with nothing to purge reports the failure too. That vault cannot persist snapshots at all.

The card shows its generic failure toast; the cause is in the log under the error id.

## Tests

`a_compaction_whose_save_failed_purges_nothing_6518` (`spaces/session_save_tests.rs`) fails the snapshot write with a trigger on `loro_doc_state`, then runs the command through a mock app's managed `WriteCtx` and the job. It asserts the op count after each. On `main` it was red with 0 ops left of 26. Its twin, `a_compaction_before_any_save_keeps_its_blocks_after_a_kill_6518`, was already there and pins that a successful save still compacts; both now share one setup helper.

Shown red, one mutation per run: the command calling the purge directly (the card's assertion), the job calling it directly (the job's assertion, and the twin loses its block), the guard inverted (the twin fails on the refusal), the guard disabled.

## The audit's other notes

- `ingest_replicated_record` was a pass-through to a private `ingest_remote_record`. The body is folded into the public function, and the nine files whose comments named the private one now name the one that exists.
- `SyncScheduler::record_success` was an alias of `clear_peer_backoff`. `clear_peer_backoff` stays: it is true of both callers, a successful sync and a press on Sync.
- The fixed-seed conformance fuzz runs with the Rust tests, which a PR that changes only `src/lib/tauri-mock/` skips (#6567, routing left as it is). The heading in `conformance_fuzz.rs` and the sentence in `src-tauri/tests/AGENTS.md` said "every PR".
- `prepare_outgoing`'s refusal logs `stale_blocks`, a count, instead of scanning for the smallest id.
- Two trades nobody has seen fail got one comment each and no code: a capture link delivered twice prefills twice (`withLinkText`), and the edit rebase releases the engine lock before the apply (`engine_block_content`).

## #6653, reviewed after the merge

`agaric-mcp call` merged with no review, because a force-push does not start one. Read as the reviewer would: no blocking defect. The server never builds an `is_error` result (tool failures are JSON-RPC errors), so exit 0 cannot carry a failure; arguments are checked before anything connects; no token reaches stdout, stderr or a log. Left alone: `call_failed` prints with `eprintln!`, so `2>&1 | head -c N` on a large result aborts with 134 instead of exiting 1. It is nonzero either way and the bridge path prints the same way.

## Traps

- The `tauri-command-instrumented` hook follows a command to the helper it calls, so the new helper needs its own `#[instrument]`.
- A first build with incremental compilation on would not have fit the disk; `CARGO_INCREMENTAL=0` throughout.

## What ran

`cargo nextest run --workspace` in two halves (4028 and 4021 passed), `cargo test --workspace --doc`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx` and `just gen-bindings` (no diff), `npm run lint`, `npm run typecheck`, the Quick Capture vitest file, both prek stages, and `e2e/capture-deep-link.spec.ts`.

Not run: the other 50 Playwright specs `just e2e-related` selects (the frontend change is one comment) and the WebdriverIO lane (it selects the whole lane; CI's run is the check).
