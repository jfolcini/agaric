-- Write-ahead durability slot for inbound Loro sync messages (#535).
--
-- Closes a data-loss window in `sync_protocol::loro_sync::apply_remote`:
-- it imports remote Loro bytes into the engine (which a periodic job later
-- persists to `loro_doc_state`) BEFORE the SQL projection tx commits. A crash
-- between that persist and the commit left the engine ahead of SQL, and boot
-- recovery rebuilds SQL from `op_log` (which never carries remote Loro-only
-- data) — so the synced data became invisible.
--
-- The fix is a write-ahead inbox: each inbound message's raw bytes are
-- INSERTed here in their own committed tx BEFORE the engine import, and the
-- row is DELETEd in the SAME tx as the SQL projection. A leftover row at boot
-- means a crash interrupted that window; boot recovery replays it (re-import
-- is idempotent — Loro import is idempotent and SQL projections are upserts —
-- and bypasses the reachability gate, so only the raw bytes + space_id are
-- needed for replay; `kind` / `from_vv` are not stored).
--
-- STRICT per migrations/AGENTS.md. `created_at` is ms-since-UNIX-epoch (UTC),
-- written via crate::db::now_ms() (cf. 0079/0082), kept only for diagnostics
-- and FIFO replay ordering (the AUTOINCREMENT `id` is the authoritative order).
CREATE TABLE loro_sync_inbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id      TEXT NOT NULL,
    bytes         BLOB NOT NULL,
    created_at    INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
