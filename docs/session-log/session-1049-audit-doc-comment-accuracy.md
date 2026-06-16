# Session 1049 — audit fixes #1277/#1278/#1246: in-code doc-comment accuracy

2026-06-16. From the 2026-06 Opus quality audit (documentation). `/loop /batch-issues` run.
Comment/docstring-only; each verified against the current code; no behavior change.

- **#1277** `maintenance.rs` (+ matching `lib.rs` comment) — the module header called the
  daemon a "skeleton" and framed shipped jobs as hypothetical future work. The daemon now
  wires **8 live jobs** (wal_checkpoint_truncate, op_log_compact, pragma_optimize_tick,
  cleanup_orphaned_attachments_tick, fts_idle_optimize, tombstone_purge,
  loro_snapshot_if_dirty, projected_agenda_midnight). Rewrote the header to enumerate the
  registered set accurately (verified every fn name).

- **#1278** `hash.rs` — `verify_op_hash`'s doc claimed "constant-time comparison to prevent
  timing side-channel leaks". It's a fixed-length blake3-hex **integrity** equality check;
  the single-user local-first threat model has no timing attacker (and the helper isn't
  constant-time across unequal lengths anyway). Reframed the comments as a data-integrity
  check that is explicitly not a security boundary. Comment-only (no rename — private
  helper, behavior unchanged).

- **#1246** `orchestrator.rs` — `head_exchange_outgoing_loro`'s docstring said `peer_vv` is
  initial-sync-only with incremental Updates a "follow-up", contradicting its own body
  (looks up a per-space `peer_vv` and ships an incremental Update when advertised, else a
  Snapshot). Corrected to match the shipped behavior (the spec/docs were already fixed in
  #87/#1247; this is the in-code docstring).

`cargo check` clean.
