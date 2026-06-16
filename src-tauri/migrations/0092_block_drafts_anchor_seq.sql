-- Issue #1256: anchor crash-draft supersession on a MONOTONIC op-log seq,
-- not on the non-monotonic wall-clock (`now_ms()`).
--
-- THE BUG. `recover_single_draft` decided a draft had already been flushed by
-- counting `op_log` rows whose `created_at > block_drafts.updated_at` (with a
-- same-ms content tie-breaker, #384). Both timestamps come from
-- `crate::db::now_ms()`, which `db/pool.rs` documents as NON-monotonic — it
-- steps backward on an NTP correction or a manual clock change. A backward
-- step > 1 ms between the last `save_draft` and the superseding flush op makes
-- the flush op's `created_at < draft.updated_at`, so the supersession count is
-- 0, and recovery re-applies the OLDER draft as a fresh `edit_block` — silently
-- clobbering the newer flushed edit.
--
-- THE FIX. Record, at draft-save time, the op-log high-water for the LOCAL
-- device — `MAX(seq)` over `op_log WHERE device_id = <local>` — as the draft's
-- monotonic anchor. The op-log `seq` is a per-device strictly-increasing
-- counter (`op_log` PRIMARY KEY `(device_id, seq)`, assigned by
-- `COALESCE(MAX(seq),0)+1` in `append_local_op_in_tx`), so it is immune to
-- wall-clock motion. The anchor means: "every op up to seq S is already
-- reflected in this draft's view." Recovery then treats the draft as
-- superseded iff a block-scoped op exists with `seq > draft_anchor_seq` on the
-- SAME device — a clock-independent comparison.
--
-- `block_drafts` is the project's one mutable scratch table (device-local;
-- never synced, snapshotted, or compacted) and is written exclusively via
-- `INSERT OR REPLACE`, so a plain `ALTER TABLE ... ADD COLUMN` is sufficient —
-- no table rebuild is needed and none of the FK/STRICT properties from 0082
-- are disturbed. (`ALTER TABLE ADD COLUMN` on a STRICT table preserves STRICT;
-- the migrations-strict-required hook only governs new `CREATE TABLE`s.)
--
-- DEFAULT 0 backfills any draft that survived an upgrade. `seq` starts at 1
-- (`COALESCE(MAX(seq),0)+1`), so anchor 0 means "no local op preceded this
-- draft": ANY block-scoped op then has `seq > 0` and supersedes it. That is
-- the safe bias — an upgraded draft of unknown provenance defers to any
-- existing op rather than risk clobbering it.
--
-- `draft_anchor_device` records WHICH device's seq space the anchor lives in,
-- so the recovery comparison stays within a single (comparable) per-device
-- counter. NULL (the legacy/backfill default) is treated as "matches the
-- recovering device" by the recovery query.

ALTER TABLE block_drafts
    ADD COLUMN draft_anchor_seq INTEGER NOT NULL DEFAULT 0 CHECK (draft_anchor_seq >= 0);

ALTER TABLE block_drafts
    ADD COLUMN draft_anchor_device TEXT;
