# Session 1077 — /batch-issues loop: pairing limits + legacy migration, batch 25 (2026-06-20)

## What happened

Robustness batch of the overnight `/loop /batch-issues` run, built in worktree
`wt-batch25`. Two findings — a pairing hardening pair and a delicate migration-ordering
fix — each adversarially reviewed (the migration with extra scrutiny since it reorders
real document data).

## Shipped

PR `fix/pairing-migration-deep-review-11`:

- **#1603** (robustness) — pairing had no passphrase attempt counter (only the session
  time limit bounded retries) and the pending-pairing marker never expired
  (`is_pending_pairing` checked only `value=='1'`; `clear_pending_pairing` ran only when
  a real peer appeared), so an abandoned pairing left the daemon in pairing mode
  indefinitely. Added `MAX_PASSPHRASE_ATTEMPTS = 5` + a `failed_attempts` counter to
  `PairingSession`; the 5th failed passphrase drops the slot and returns
  `attempts_exhausted` (forcing a clean re-initiation — re-pairing resets the counter,
  not a permanent device lockout). Promoted the existing `PAIRING_TIMEOUT` (300 s) const
  to production and reused it as `PENDING_PAIRING_TTL_MS`; `is_pending_pairing` now treats
  a marker older than the TTL as not-pending and clears it lazily (clock-skew safe via
  signed `saturating_sub`). Both constants derive from existing precedent.
- **#1585** (robustness) — `migrate_legacy_sibling_order` did a doc-global reorder keyed
  on `unwrap_or(i64::MAX)`, so a single legacy position-bearing node dumped ALL
  position-less siblings (in every parent) to the end, losing their fractional order.
  Made it per-parent aware with "pinned position-less slots": a parent with zero legacy
  children is skipped (untouched); in a mixed/fully-legacy parent the slots occupied by
  position-less children are pinned (keep their slot + relative order) while legacy
  children are sorted by the pre-#400 `(position, block_id)` and redistributed only into
  the slots legacy children currently occupy. A fully-legacy parent reduces exactly to
  the original sort. Idempotent (version-marker gate + same-index `mov_to` no-ops on
  re-run).

## Review pass

- **#1603** reviewer (APPROVE): attempt counter is exactly 5 (5th drops the slot), the
  increment only fires on a genuine passphrase mismatch, the happy path persists the
  peer, TTL units/underflow are clock-skew safe, and `.sqlx` verified with
  `prepare --check -- --tests` (the one pruned entry is a benign orphan left by #1574's
  chunked-replay refactor). Mutation-checked both tests. 63 tests pass.
- **#1585** reviewer (APPROVE): verified the no-legacy-parent path emits zero ops (even
  at the Loro `move_to` layer — same-index is a no-op), hand-traced the mixed-parent
  example `[N1,L1(20),N2,L2(10),N3] → [N1,L2,N2,L1,N3]`, confirmed fully-legacy = original
  behavior (no regression), idempotency (both the version gate and the algorithm), and a
  strong mutation-kill (the mixed-parent test fails with exactly the old i64::MAX
  pathology under the buggy algorithm). 124 tests pass. Owned the full
  `clippy --all-targets` run.

## Notes

- The full-clippy run surfaced one `cast_possible_truncation` lint in #1603's
  `peer_refs.rs` (`PAIRING_TIMEOUT.as_millis() as i64`, where the #1603 reviewer's
  targeted-nextest pass didn't reach it); annotated `#[allow(clippy::cast_possible_truncation)]`
  (a 5-minute TTL fits i64 trivially) and re-verified `clippy --all-targets` clean.
- Files: `pairing.rs`, `commands/sync_cmds.rs`, `peer_refs.rs` + `.sqlx` (2 new, 1
  orphan pruned) (#1603); `loro/engine/migration.rs`, `loro/engine/mod.rs` (#1585).
- Branch base is current `origin/main`.
