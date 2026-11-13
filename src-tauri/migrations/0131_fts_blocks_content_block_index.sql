-- #6534: find a block's `fts_blocks` row without scanning the index.
--
-- `fts_blocks.block_id` is UNINDEXED and FTS5 addresses rows by rowid only,
-- so `DELETE FROM fts_blocks WHERE block_id = ?` visits every row. FTS5 keeps
-- the column values in its shadow table `fts_blocks_content(id, c0, c1)`,
-- where `id` is the FTS rowid and `c0` the first declared column, `block_id`.
-- With this index the writers in `agaric-store/src/fts/index.rs` look the
-- rowid up here and delete by rowid.
--
-- The index belongs to the shadow table, so a migration that drops and
-- recreates `fts_blocks` drops it too and must recreate it;
-- `fts_delete_by_block_id_plans_pin_the_rowid_lookup_6534` fails when it is
-- gone. Emptying the table (`DELETE FROM fts_blocks`, the full rebuild) and
-- FTS5's 'merge' and 'optimize' keep it.
--
-- No rebuild of the search index: existing rows are indexed in place.
--
-- mock-unaffected: the mock has no fts_blocks table.

CREATE INDEX idx_fts_blocks_content_block ON fts_blocks_content (c0);
