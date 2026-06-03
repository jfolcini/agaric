# Session 960 — #374 CRITICAL: recover attachments cascade-deleted by the blocks rebuild

**Date:** 2026-06-03
**Scope:** Fix the highest-severity finding from the multi-agent SQL review (#374):
migrations 0073/0080 silently destroy all `attachments` metadata on upgrade.

## Symptom

The canonical 12-step `blocks`-table rebuild in migrations 0073 and 0080 runs
`DROP TABLE blocks; … RENAME` inside the sqlx migration transaction with
`PRAGMA foreign_keys = ON` (db.rs:460; a PRAGMA cannot be toggled mid-tx).
Migration 0061 gave `attachments.block_id` an `ON DELETE CASCADE` to
`blocks(id)`, so `DROP TABLE blocks` cascade-deletes **every** `attachments`
row before the rename restores the parent. Unlike `block_properties` /
`block_tags` (derived caches rebuilt from the op-log), `attachments` is the one
**authoritative** child — its rows are the source of truth for `fs_path`,
`mime_type`, `filename`, `size_bytes` — and nothing replayed it. Result: any
user upgrading through 0073 with attachments lost all attachment metadata and
orphaned the on-disk blobs, with no error surfaced. Empirically reproducible
(`PRAGMA foreign_key_check` reports clean afterward).

## Root cause

`recover_derived_state_from_op_log` (db.rs) replayed `set_property` /
`delete_property` / `add_tag` from the op-log after migrations, but had no
`add_attachment` / `delete_attachment` arm — so the cascade-emptied
`attachments` table was never restored.

## Fix

Added `add_attachment` and `delete_attachment` replay arms to
`recover_derived_state_from_op_log` (db.rs):

- The op-log `AddAttachmentPayload` (op.rs:212) carries every NOT NULL column
  the row needs (`attachment_id, block_id, mime_type, filename, size_bytes,
  fs_path`); `created_at` comes from the op row — the same value the live
  `apply_add_attachment` writes. The arm `INSERT OR IGNORE`s the row guarded by
  `WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)` so a purged owning block
  can't trip FK 787, and stays idempotent across boots.
- `delete_attachment` hard-deletes by id so a later delete wins over its earlier
  add in the `(created_at, device_id, seq)` LWW replay order.

The arms ride the **existing** all-derived-tables-empty guard: 0061 gave
properties, tags, and attachments all `ON DELETE CASCADE`, so they empty
together on the corruption path — no guard change needed. On the next boot
after this ships, a damaged DB (attachments empty, op-log intact) auto-restores.

### Notes / deliberately NOT done

- **Migration comments left untouched.** The 0073/0080 headers assert the
  rebuild is FK-safe (false). sqlx checksums the *entire* migration file
  (comments included), so editing applied migrations would break checksum
  validation on every existing DB. The accurate explanation now lives in the
  db.rs recovery code. (The #386 docs issue will note this.)
- **Compaction horizon:** like all op-log-replay recovery (blocks/props/tags),
  this restores only attachments whose `add_attachment` op still exists; ops
  predating an op-log compaction are covered by the snapshot/restore path
  (snapshot/restore.rs), which snapshots the live `attachments` table — not a
  regression.
- **Pre-existing inefficiency (follow-up candidate):** a user with attachments
  but zero properties/tags re-walks the full op-log every boot (already true for
  the property/tag arms). Harmless (`INSERT OR IGNORE`), just wasteful.

## Verification

- New regression `init_pool_recovery_restores_attachments_374` (db.rs tests):
  seeds create_block + add_attachment/delete_attachment ops, `DROP TABLE blocks`
  to reproduce the cascade, reopens, and asserts: live attachment restored with
  every column intact (incl. `created_at`), attachment on a missing block
  skipped (no FK abort), added-then-deleted attachment absent, and a second boot
  is idempotent (no dup/crash).
- `cargo nextest` `db::tests`: 43 passed / 0 failed.
- Independent technical review (separate agent): confirmed FK-safe, idempotent,
  column-complete, no startup-abort path; payload field names match op.rs.
