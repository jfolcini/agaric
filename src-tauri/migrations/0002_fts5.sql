-- FTS5 full-text search index for blocks
CREATE VIRTUAL TABLE IF NOT EXISTS fts_blocks USING fts5(
    block_id UNINDEXED,
    stripped,
    tokenize = 'unicode61'
);
