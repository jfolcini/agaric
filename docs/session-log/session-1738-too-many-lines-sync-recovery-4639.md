# Session 1738 — the sync recovery splits (#4639)

Refs #4639, twelfth slice: the six `#[expect(clippy::too_many_lines)]` sites in
`agaric-sync/src/recovery/` (`replay.rs`: `heal_orphaned_apply_cursor`,
`replay_unmaterialized_ops`; `sync_inbox.rs`: `replay_sync_inbox`;
`draft_recovery.rs`: `recover_single_draft`; `boot.rs`: `recover_at_boot`;
`attachment_blob_backfill.rs`: `backfill_attachment_blobs`). Pure moves: every
SQL literal, log line, error string, tracing field, engine call, await point
and early return keeps its text and its order.

- `heal_orphaned_apply_cursor` (84 → 59 code lines): `plan_cursor_rewind`
  carries the three reads and the `reset_to` decision and returns
  `Option<RewindPlan>`. A struct rather than a tuple because all four readings
  are `i64` and three of them are tracing fields the announce block names by
  shorthand; the caller destructures into identically-named locals, so the
  `error!`/`debug!`/`warn!` blocks are byte-identical. The function's three
  "nothing to heal" exits became `Ok(None)` at the same points.
- `replay_unmaterialized_ops` (183 → 60): `ensure_single_device_op_log` (the
  #412 release guard), `enqueue_ops_for_replay` (the chunked walk, returning
  the seq it reached and the device id the reproject needs),
  `record_group_error` (the closure, now a free fn because both halves of the
  reproject call it), `read_final_child_orderings` and `reproject_orderings`.
  The last two are the #2295/#2896 end-of-replay reproject cut at its existing
  seam: the comment already said "do ALL engine reads first, THEN run the
  async loop with no guard held", so the read half is now a **synchronous**
  `fn`. The guard already could not cross an await — it sat inside an
  immediately-invoked sync closure before this change too. What the split
  adds is that the whole read loop is now non-`async`, so a future `.await`
  added anywhere in it fails to compile instead of silently holding the
  `!Send` `EngineGuard`.
- `replay_sync_inbox` (131 → 47): `next_chunk_grouped_by_space` (the bounded
  `id > last_seen` fetch plus the per-space grouping), `decode_purged_tombstone`
  (#2292's parse-or-fall-back-to-empty) and `replay_space_batches`. Five
  accumulators crossed the seam, which would have put the batch helper over the
  argument cap, so they moved into an `InboxReplayTally`; the walk destructures
  it back into the original names afterwards so the fan-out and the summary log
  are unchanged.
- `recover_single_draft` (90 → 49): `write_back_unflushed_draft` is the whole
  `matching_ops == 0` arm — over-cap refusal, `prev_edit`, the IMMEDIATE
  transaction, the #1322 enqueue. Its two `return Err` exits are the caller's
  `?`.
- `recover_at_boot` (176 → 62): one helper per numbered step —
  `replay_sync_inbox_with_quarantine_census` (step 1.6, including the #3226
  before/after census and its ERROR-vs-WARN choice), `recover_drafts` (step 2,
  with `live_draft_block_ids` for the chunked IN-clause pre-check) and
  `run_attachment_backfills` (step 3). The two outcome structs
  (`SyncInboxOutcome`, `DraftRecoveryOutcome`) exist because each step feeds
  three same-typed fields straight into `RecoveryReport`, where a tuple would
  be positional. The once-only `RECOVERY_DONE` guard, `Instant::now()` and the
  op-log replay stay in `recover_at_boot`.
- `backfill_attachment_blobs` (117 → 40): `hash_groups_canonical_first`,
  `canonical_path_for_hash` (the idempotent `INSERT OR IGNORE` plus the
  read-back that makes repointing follow the STORED path) and
  `repoint_rows_to_canonical`.

Drop order: nothing in these files holds a lock, scope guard, multicast lock,
activity counter or event sink across a seam. The only `Drop`-sensitive binding
is the per-space `EngineGuard` in `replay.rs`, and it is taken and dropped
inside the same immediately-invoked closure it always was — now inside a
synchronous helper, so its scope shrank rather than moved. `dirty` (the
`ReplayDirtyParents` sink) is created and drained in `replay_unmaterialized_ops`
and only borrowed by the walk helper, so the aborted-replay path still drops it
exactly where it did.

No `#[allow]` or `#[expect]` was added, and no existing item was renamed or
reordered. `replay_space_batches` is plural because it loops over the chunk's
groups; `scripts/check-bulk-equivalence.mjs` matches the `_`-separated segment
`batch` exactly, so `batches` is out of its scope — the same way
`sync_protocol/session_state_machine.rs::collect_op_batches_for_peer` already
is. The baseline is unchanged.

## Verified

Counted, not assumed: `grep -ro 'expect(clippy::too_many_lines' --include=*.rs
src-tauri | wc -l` goes from **73 to 67** across the workspace. (It was
78 → 72 while this slice sat on the pre-#5006 base; rebasing onto that
merge moved both ends down by its five, leaving the delta of six — the six
sites this slice removes — unchanged.)

- `cargo clippy -p agaric-sync --lib --tests -- -D warnings`:
  `Checking agaric-sync v0.1.0 … Finished dev profile … in 10.38s`, no
  diagnostics. With `-D warnings` this is the oracle in both directions: the
  attribute is gone, so a function still over 70 lines would fail here.
- Falsified on a copy and restored byte-exact (`cmp` clean): re-adding
  `#[expect(clippy::too_many_lines, reason = "falsification probe")]` to
  `recover_at_boot` produces
  `warning: this lint expectation is unfulfilled --> agaric-sync/src/recovery/boot.rs:80:10`.
- `cargo fmt --all -- --check`: clean (rustfmt reflowed four files after the
  dedent; the run above is post-`cargo fmt --all`).
- `node scripts/check-bulk-equivalence.mjs`:
  `OK: 53 bulk-named function(s) inventoried (6 converged, 13 covered, 2
  exception, 1 gap, 7 not-a-fan-out, 9 read-only, 15 wrapper), no new entries,
  no stale entries`, exit 0.
- `cargo nextest run -p agaric-sync`:
  `Summary [117.445s] 968 tests run: 968 passed (2 slow), 1 skipped`.
- `cargo check -p agaric --lib`: `Finished dev profile … in 46.76s` — the
  app crate still compiles against the changed crate (`-p` alone would not
  have said so).
- String-literal multisets of all five files were lexed before and after
  (comment-aware, raw-string-aware, with Rust's `\`-newline continuation
  applied so a dedent inside a wrapped literal is not counted as a change).
  The only difference is `'#4639: split before growing'`: 2/1/1/1/1 → 0.
- `registry.for_space` acquisitions in production code under `recovery/`: **1
  before, 1 after** (`replay.rs`, the dirty-group read). Unchanged, and now in
  a non-`async fn`.

Not run in this session, left to the reviewer: `cargo nextest run --workspace`,
`cargo test --doc`, the `prek` hook set, Playwright.
