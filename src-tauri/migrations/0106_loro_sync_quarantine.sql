-- #3226 — durable quarantine for permanently-stuck Loro-sync inbox slots.
--
-- Background. #3194 (batch replay) and #3213 (live `apply_remote` + per-row
-- `replay_inbox_row`) made a write-ahead `loro_sync_inbox` slot survive when the
-- post-import `oplog_vv()` did not reach the frontier the blob DECLARED: the
-- payload parked in loro's `pending_changes`, so it is in neither the op-log nor
-- SQL, and the slot row is its only durable copy. Deleting it there would be the
-- #535 violation those guards exist to prevent.
--
-- The cost that fix accepted is that a PERMANENTLY unsatisfiable slot (a
-- truncated or corrupt blob, or a sender that declared a base it will never
-- supply) is re-imported once per boot, logged as an error, forever, with no
-- resolution path. Both prior PRs rejected a retry CAP for the right reason: the
-- only bound available *without new storage* is deleting the row, i.e. trading a
-- bounded, visible annoyance for unbounded, silent data loss.
--
-- This migration is that new storage. A slot that stays unresolved across
-- `QUARANTINE_AFTER_BOOTS` consecutive boot replays is MOVED — never copied and
-- never dropped — into `loro_sync_quarantine` inside one transaction. The bytes
-- stay durable (so #535 is satisfied exactly as before), the retry loop
-- terminates, and the stuck blob becomes queryable instead of log-only.
--
-- Two schema pieces:
--
--  1. `loro_sync_inbox.unresolved_boots` — how many boot replays have observed
--     this slot fail to clear. Incremented by the boot walk only (the live
--     `apply_remote` path inserts a FRESH row per delivery, so a live keep is
--     always attempt #0 and must not count). `DEFAULT 0` backfills every
--     pre-existing row as "never yet retried", which is the conservative
--     direction: an already-stuck slot gets the full boot budget from here.
--
--  2. `loro_sync_quarantine` — the side table. Holds the blob bytes verbatim,
--     the #2292 purge tombstone, the frontier the blob declared, the last
--     observed shortfall/error, and enough provenance (`inbox_id`,
--     `first_seen_at_ms`) to reconstruct what happened without the logs.
--
-- Re-admission is MANUAL only — see `readmit_quarantined_slot` in
-- `agaric-sync/src/sync_protocol/loro_sync.rs` for the full reasoning. Nothing
-- in the boot path ever reads this table back into the inbox.
--
-- STRICT per migrations/AGENTS.md. All timestamps are INTEGER ms-since-epoch
-- (#109) written via `agaric_store::db::now_ms()`; `first_seen_at_ms` is copied
-- straight from the inbox row's `created_at`, which is the same encoding
-- (migration 0084).
--
-- mock-unaffected: the browser/e2e Tauri mock models no sync write-ahead or
-- quarantine state at all (`loro_sync_inbox` is absent from the mock's stores
-- and from the CONTRACT map in scripts/check-migration-mock-contract.py); this
-- table is backend crash-recovery storage with no command surface in the mock.

ALTER TABLE loro_sync_inbox ADD COLUMN unresolved_boots INTEGER NOT NULL DEFAULT 0;

CREATE TABLE loro_sync_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The `loro_sync_inbox.id` this row was moved from. Kept for provenance /
  -- log correlation; it is NOT a foreign key, because the inbox row is deleted
  -- in the same transaction that inserts this one.
  inbox_id INTEGER NOT NULL,
  space_id TEXT NOT NULL,
  -- The raw Loro-sync blob, byte-identical to what the inbox held. This is the
  -- #535 durable record: quarantining must never lose a byte.
  bytes BLOB NOT NULL,
  -- #2292 durable purge tombstone carried over from the inbox row (JSON array
  -- of block ids), or NULL for a non-purge slot.
  purged_ids TEXT,
  -- JSON array of `[peer_id_string, counter]` pairs — the `partial_end_vv` the
  -- blob declared, i.e. the frontier the op-log had to reach for the slot to be
  -- clearable. `peer_id` is stringified because loro's PeerID is a u64 and JSON
  -- numbers are f64. `[]` for a blob that declared nothing or whose metadata
  -- would not decode.
  declared_end_vv TEXT NOT NULL,
  -- The last observed reason the slot did not clear: either
  -- `LoroEngine::oplog_shortfall`'s diagnostic, or the replay error for a blob
  -- that could not be imported at all.
  last_reason TEXT NOT NULL,
  -- How many boot replays observed this slot unresolved before it was moved
  -- here (>= QUARANTINE_AFTER_BOOTS).
  unresolved_boots INTEGER NOT NULL CHECK (unresolved_boots >= 0),
  -- The inbox row's `created_at` — when the blob was first durably admitted.
  first_seen_at_ms INTEGER NOT NULL CHECK (first_seen_at_ms >= 0),
  quarantined_at_ms INTEGER NOT NULL CHECK (quarantined_at_ms >= 0)
) STRICT;

-- Per-space diagnostics lookup. NOT used by today's two readers
-- (`list_quarantined_slots` lists every row; `count_quarantined_slots` is an
-- unfiltered COUNT(*)) — it ships with the table per migrations/AGENTS.md
-- ("indexes go in the same migration that creates the table") for the
-- space-scoped surface the #3226 follow-up needs, on a table that is expected
-- to hold a handful of rows either way.
CREATE INDEX idx_loro_sync_quarantine_space ON loro_sync_quarantine (space_id);
