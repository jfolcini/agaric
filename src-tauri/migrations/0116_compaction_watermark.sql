-- #4699 — replace the `log_snapshots` blob with a compaction watermark row.
--
-- `log_snapshots` stored a zstd-CBOR dump of the DERIVED SQL tables
-- (blocks, block_tags, block_properties, …) alongside the op frontier the
-- purge ran to. After #3487 nothing read the blob: `apply_snapshot` and
-- `get_latest_snapshot*` lost their last production callers, and building
-- the blob buffered the whole vault in memory on every compaction tick —
-- against Android's ~24 MB release heap. Loro (`loro_doc_state`) is the
-- merge truth `db/recovery.rs` reprojects the derived view from, so the
-- blob was a second, staler, partial copy of something reconstructible.
--
-- What survives is the part compaction actually needs: a marker saying a
-- purge has run, plus the frontier it ran to.
--
-- ## What reads this table
--
-- Only its EXISTENCE, by `agaric_engine::dag::find_lca`, to choose between
-- "edit chain broken … likely due to op log compaction" and a plain
-- NotFound when a chain walk hits a purged op. `up_to_seqs` / `up_to_hash`
-- are the durable record of how far the last purge reached — written for
-- diagnosis, not read by any code path. Do not treat them as a retention
-- floor: `compact_op_log` recomputes the frontier under its own read
-- transaction every run (it always did; the `log_snapshots` copy was never
-- read back either).
--
-- ## Carry-forward
--
-- A vault that has already compacted has a `status='complete'` row here.
-- Copying its frontier forward keeps `find_lca`'s compaction-aware wording
-- correct across the upgrade; without it an upgraded vault would report a
-- purged op as a plain NotFound.
--
-- mock-unaffected: the browser/e2e Tauri mock models neither `log_snapshots`
-- nor this table — `compact_op_log_cmd` is a fixed stub in
-- `src/lib/tauri-mock/handlers/history.ts` that touches no store.

CREATE TABLE compaction_watermark (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    -- JSON: { device_id: max_seq } the last purge was bounded by.
    up_to_seqs TEXT NOT NULL,
    -- Hash of the newest op at that frontier. Opaque; never compared.
    up_to_hash TEXT NOT NULL,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    compacted_at_ms INTEGER NOT NULL CHECK (compacted_at_ms >= 0)
) STRICT;

-- Carry the newest complete snapshot's frontier forward. `log_snapshots.id`
-- is a ULID, so `ORDER BY id DESC` is newest-first. No row is inserted when
-- the vault never compacted, which is exactly what `find_lca` must observe.
--
-- `compacted_at_ms` is the upgrade instant, not the original compaction's:
-- the old row carried no timestamp column, and its ULID id is Crockford
-- base32 that SQLite cannot decode. Nothing reads the value.
INSERT INTO compaction_watermark (id, up_to_seqs, up_to_hash, compacted_at_ms)
SELECT 1,
       up_to_seqs,
       up_to_hash,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM log_snapshots
 WHERE status = 'complete'
 ORDER BY id DESC
 LIMIT 1;

DROP TABLE log_snapshots;
