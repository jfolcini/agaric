# Session 1180 — deep-review test-quality trio (#2680, #2681, #2682)

Three deep-review test-quality issues. #2680 + #2682 shipped in PR #2870
(`test: de-vacuous the daemon-cancel test and de-flake two lock-contention tests`);
#2681 shipped in the PR this log accompanies. All are **test-only** — no production
code changed.

## #2680 — vacuous `daemon_cancel_does_not_trigger_shutdown` (PR #2870)

The test had **no assertion** between `cancel_active_sync()` and `shutdown()`, so
`shutdown()` + the closing `wait_for(handle.is_finished)` passed identically whether or
not cancel wrongly killed the daemon loop — it could never detect the regression it
names. Added a liveness assertion (`daemon.handle` still running) between the two.

## #2682 — two lock-contention tests race a fixed timing window (PR #2870)

`reindex_block_links_waits_for_competing_writer` (`agaric-store`) and
`begin_immediate_logged_emits_warn_on_slow_acquire` (`agaric`) each used a fixed
`tokio::time::sleep` (10 ms / 20 ms) to "let the holder acquire the lock first", which
false-reds under CPU saturation when the holder loses that scheduling window. Replaced
each guess with a `oneshot` **readiness handshake** — the holder signals only after it
provably owns the lock/connection; the contender awaits it before racing. Hold durations
and assertions unchanged. Each test verified deterministic via a 5× loop.

## #2681 — Purge/attachment/delete/restore absent from randomized proptests

PurgeBlock and attachment ops appeared in **no** randomized op generator, and
delete/restore were **filtered out** of the SQL-projection convergence proptests, so
tombstone/purge/attachment interleavings were never exercised through the engine-apply →
SQL-reprojection path.

- **`engine_proptest.rs`** — `OpKind::Purge` arm (gated on deleted-not-yet-purged) +
  post-purge `read_block == None` anti-vacuity asserts in the single-author and
  convergence properties.
- **`proptest_db_harness.rs`** — `OpKind::Purge`/`AddAttachment`/`DeleteAttachment`;
  `ChainModel` gains `parents`/`deleted_at`/`cohorts`/`attachments`/`step` so `Delete`
  cascades to the live subtree (matching `descendants_cte_active`) and `Move` only
  reparents to live non-descendants. `Restore`/`Purge` carry the real deterministic
  `deleted_at` (`ts_for(step)`), minting a valid `deleted_at_ref` instead of a `0`
  placeholder.
- **`apply_reproject_proptest.rs`** — stop filtering `DeleteBlock`/`RestoreBlock` from
  `prepare_chain`/`prepare_chain_b5`; the driver patches `RestoreBlock.deleted_at_ref`
  from the ts it stamped and runs the same post-commit cohort fan-out `apply_op` does.
  Purge + attachments stay filtered here (purge is structurally SQL-only on the engine
  side; both keep coverage via the engine proptest + B1 inverse law) — documented in code.
- **`proptest_b1.rs`** — structural inverse arms for attachments; Purge stays
  `NonReversible`.

Two harness modeling gaps that surfaced at `PROPTEST_CASES=128` were fixed **in the
harness** (no production change). Adversarial review verified line-by-line against
production (`apply.rs`, `crud.rs`) that both fixes are faithful to production semantics,
not cover-ups, and that **no genuine engine→SQL divergence** was masked. All suites green,
including a 128-case stress run.

## Follow-up

- **#2868** — a remotely-applied PurgeBlock leaves an engine tombstone (SQL purged, CRDT
  still soft-deleted); may resurrect as trash on a snapshot-syncing peer. Pre-existing,
  surfaced during the #2681 review; out of scope for this test-only work.
