-- Switch FTS5 from unicode61 to trigram tokenizer for CJK substring search.
-- Trigram indexes every 3-character substring, enabling CJK queries like "会議"
-- without a dedicated morphological analyzer. Index is ~3x larger but still
-- negligible for a personal notes app (<100k blocks).
--
-- The rebuild_fts_index() function repopulates on next boot.

DROP TABLE IF EXISTS fts_blocks;

CREATE VIRTUAL TABLE fts_blocks USING fts5(
    block_id UNINDEXED,
    stripped,
    tokenize = 'trigram case_sensitive 0'
);
