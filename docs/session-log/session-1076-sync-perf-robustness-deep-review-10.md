# Session 1076 — /batch-issues loop: sync perf + robustness, batch 24 (2026-06-20)

## What happened

Sync-domain batch of the overnight `/loop /batch-issues` run, built in worktree
`wt-sync24`. Two findings — one HIGH perf, one robustness — adversarially reviewed.

## Shipped

PR `fix/sync-perf-robustness-deep-review-10`:

- **#1621** (HIGH, perf) — on sync-pull, `import_and_project` called
  `engine.read_block(block_id)` once per block, and `read_block` computed `position`
  via `child_rank_position`, an O(K) `children.iter().position(...)` sibling scan. With
  N blocks and K siblings the projection was O(N·K), O(N²) for a flat space (K≈N) — the
  pattern `tree.rs` warns bulk callers against. Added
  `LoroEngine::read_blocks_bulk(&[&str])` which mirrors `read_block` field-for-field but
  derives `position` from a memoized per-parent rank index (`tree.children(parent)` run
  once per distinct parent, then O(1) lookups). `import_and_project` now makes one bulk
  call. Total cost ~O(N + Σchildren) ≈ O(N). The rank derivation is byte-identical to
  `child_rank_position` (same parent resolution, sibling order, 1-based formula, and
  fallbacks).
- **#1605** (robustness) — `handle_incoming_sync` passed a fresh, never-set `AtomicBool`
  as the responder's cancel flag (the initiator side was fully cancellable), so with
  `RECV_TIMEOUT=180s` a responder driven by a hung initiator couldn't be cancelled,
  holding the per-peer lock and task. Threaded the daemon's real shared `cancel:
  Arc<AtomicBool>` (the same flag `cancel_active_sync` flips and the initiator observes)
  into `handle_incoming_sync` via the `SyncServer::start` factory closure (signature
  unchanged → no E0593), checked at the top of the message loop and at the entry of
  `run_file_transfer_responder` (the previously-unguarded `FileRequest` recv — exactly
  the issue's hang case). The #1581 `OwnedSemaphorePermit` lifetime is untouched; on a
  flipped flag the session returns within one recv cycle and drops the per-peer guard +
  permit. A single in-flight recv still runs to `RECV_TIMEOUT` (mirrors the initiator;
  documented).

## Review pass

- **#1621** reviewer diffed the bulk rank derivation against `child_rank_position`
  line-by-line (byte-identical), confirmed no cross-parent memo bleed (scrambled
  interleaved-parent test), O(N) complexity, and mutation-checked the flat-space
  (200-sibling) + nested tests. 74 tests pass.
- **#1605** reviewer traced the cancel `Arc` end-to-end to confirm it's the genuine
  daemon-wide flag (not a fresh one), verified the #1581 permit move/drop ordering is
  unchanged, empirically mutation-checked the abort test (disabling the checks → 180s
  timeout; restored → 0.14s), and confirmed the hang-case coverage. 537 tests pass.
  Owned the full `clippy --all-targets -D warnings` run for the shared worktree.

## Notes

- The full-clippy run surfaced 3 trivial lints in #1621's code (two `redundant_closure`,
  one `cast_possible_wrap`) that the #1621 reviewer's targeted-nextest pass didn't cover;
  fixed at integration (`String::as_str` / `crate::ulid::BlockId::as_str` method paths,
  `i64::try_from`), re-verified `clippy --all-targets` clean.
- Files: `loro/engine/reads.rs`, `sync_protocol/loro_sync.rs` (#1621);
  `sync_daemon/server.rs`, `sync_daemon/orchestrator.rs`, `sync_files.rs`,
  `sync_daemon/tests.rs` (#1605). No `.sqlx` / SQL changes.
- Branch base is current `origin/main`.
