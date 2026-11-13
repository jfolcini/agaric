# Session 4011 — compaction runs in the foreground, drops the DAG, gets a real-backend spec

`Refs #6518`, all three boxes, one commit each, in reverse of the issue's order (the brief's).

- **The pre-Loro merge DAG is gone.** `find_lca`, `text_at`, `append_merge_op`,
  `has_merge_for_heads`, `insert_remote_op`, `walk_edit_chain`, `MAX_LCA_STEPS`, `WalkOutcome` and
  the `Strict` ingest profile had no production caller. The store's `insert_merge_op_in_tx` went too:
  `append_merge_op` was its only caller. `ingest_replicated_record` is now the one entry point, so the
  profile enum went and the parent check only warns. The integrity tests that drove
  `insert_remote_op` (hash, NUL, divergence, `SetProperty` domain, parents) now drive the audit path.
  The strict-only tests were deleted with `proptest_b2.rs`, and so was its nextest slow-timeout entry.
- **The compaction watermark is no longer written.** `collect_frontier` stops computing the hash
  that only the row stored. The table stays, documented as dead in `crdt-and-recovery.md`, the way
  `peer_refs.cert_hash` is. Its 0116 migration tests stay because the migration still runs on old
  vaults. `just gen-sqlx` pruned five queries; the repo has one cache, `src-tauri/.sqlx`, not four.
- **Idle-gated jobs get a grace.** `MaintenanceJob` gains `predicate_grace` and the
  `skipped_since` state behind it. A job that has been due and held back by its predicate for that
  long runs anyway. `op_log_compact` and `tombstone_purge` take `IDLE_JOB_GRACE` (one hour). The WAL
  truncate does not: `journal_size_limit` bounds the WAL in the foreground. The grace clock resets
  only on a successful run, so a failed grace run is retried the next tick, like any failed job.
- **Spec:** `e2e-tauri/compaction-restart.e2e.ts`. It writes a page, then ages every op 200 days in
  `notes.db` through the mutation-bypass sentinel (`created_at` is not hashed). It compacts through
  History's card and reads the apply cursor from `notes.db` before restarting, because the boot
  heals a stale cursor. After the restart it reads the page back and checks History no longer lists
  the compacted op. A post-restart write gives the absence check a row to wait behind. The issue's
  optional second-device `it` was left out.

Ran: both nextest partitions after boxes 1 and 2 (all passed), clippy `-D warnings`, the `cargo doc`
link denies, `prek run --all-files`, `npm run typecheck`, `npx vitest run e2e-tauri`, and
`node --test scripts/e2e-related.test.mjs`. The maintenance tests went red on the predicted
assertions before the fix. Deleting the `skipped_since` reset turns them red again.

Not run: the new WebdriverIO spec. The container has no `tauri-driver` or `WebKitWebDriver`, so it
has not been shown red by skipping the cursor clamp, which the issue asks for.

Trap: a full test build with incremental compilation filled the session's disk (17 GB of
`target/debug/incremental`). `CARGO_INCREMENTAL=0` kept the later builds in budget.
