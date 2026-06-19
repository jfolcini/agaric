# Session 1074 — /batch-issues loop: backend perf + robustness, batch 23 (2026-06-19)

## What happened

Backend lane of the night `/loop /batch-issues` run (batch 23), built in worktree
`wt-be23`, overlapped with the batch-22 god-file splits and the FE seed-recovery fix
(#1566). Three disjoint findings — one HIGH perf, two robustness — each adversarially
reviewed; the #1586 reviewer additionally owned the single full
`clippy --all-targets -D warnings` gate for the shared worktree (clean).

## Shipped

PR `fix/be-perf-robustness-deep-review-9`:

- **#1620** (HIGH, perf) — `add_attachment_inner` opened the IMMEDIATE (exclusive
  writer) transaction, then read the entire attachment file (up to 50 MB) from disk
  and blake3-hashed it before the op-log append / INSERT / commit, holding the single
  SQLite writer lock across multi-MB I/O and serializing every other write behind it
  (worst on slow/contended storage). Hoisted the file stat + size check and the
  read+hash to BEFORE `begin_immediate` (they depend only on disk bytes). The
  block-exists check stays inside the tx (TOCTOU-safe vs the INSERT). Hash value,
  op-log payload, INSERT binds, and commit ordering are byte-identical; the lock is now
  held only across the DB work.
- **#1595** (robustness) — `has_merge_for_heads` used `instr(parent_seqs, ?) > 0` to
  find the JSON tuple `["device", seq]`, correct only by fragile invariants (JSON-safe
  UUID device ids, single-decimal seq, the closing `]` preventing prefix matches).
  Replaced with a structural membership test:
  `EXISTS (SELECT 1 FROM json_each(parent_seqs) WHERE json_extract(value,'$[0]') = ?
  AND json_extract(value,'$[1]') = ?)`, binding device and seq as typed params. Removes
  all three fragile invariants; behavior preserved on valid data. (Runtime query — the
  #646 baseline count is unchanged; the `json_extract(payload,'$.block_id')` guard is
  unaffected.)
- **#1586** (robustness) — `encode_snapshot` returned raw `zstd(CBOR)` with no payload
  digest, so a flipped bit inside a still-valid zstd frame restored corrupted data
  undetected. New blob format: `SNAPSHOT_MAGIC ("AGSNAP01", 8B) ‖ blake3(zstd_payload)
  (32B) ‖ zstd(CBOR)`. Decode classifies by the leading bytes — new magic (first byte
  0x41) recomputes blake3 over the streamed payload (draining it fully so a trailing
  flip is caught) and rejects a mismatch with a clear `AppError::Snapshot` BEFORE
  surfacing any decode error; anything else (legacy bare-zstd, first byte 0x28) decodes
  via the unchanged path with no checksum. Back-compat is bulletproof: the two magics
  can never collide. Streaming bomb-bounds (#428/L-67) and `up_to_hash` are untouched.
  One coupled test in `sync_daemon/snapshot_transfer.rs` (fed encode output to a raw
  zstd decoder) was updated to skip past the new header.

## Review pass

Three adversarial reviewers, all APPROVED:
- **#1620**: block-exists check confirmed inside the tx; behavior byte-identical; the
  one error-ordering edge (block-missing + file-unreadable now yields an I/O error
  instead of NotFound) is only reachable in a doubly-broken state and both funnel to
  the same FE toast — immaterial. 90 tests.
- **#1595**: confirmed the `json_each`/`json_extract` comparison is type-correct (not
  silently always-false), clean on the dynamic-SQL baseline and the block_id guard,
  handles empty/NULL/JSON-special edge cases. 69 tests. Non-blocking caveat: the two
  new tests also pass under the old `instr()` (serde_json's `]` boundary protects the
  fixtures), so they don't mutation-kill the revert — filed as a follow-up; the
  production change is strictly more robust regardless.
- **#1586**: back-compat misclassification impossible (0x41 vs 0x28), digest covers the
  exact stored bytes and drains the whole payload, mismatch-priority ordering correct,
  bomb-bounds preserved, cross-file test edit faithful, bit-flip test mutation-checked.
  Owned the full `clippy --all-targets -D warnings` run for the whole worktree: clean.
  180 snapshot tests.

## Notes

- Files: `commands/attachments.rs` (#1620), `dag.rs` + `dag/tests.rs` (#1595),
  `snapshot/codec.rs` + `snapshot/tests.rs` + `sync_daemon/snapshot_transfer.rs`
  (#1586). No `.sqlx` changes (no `query!` macros touched).
- Branch base is current `origin/main`.
