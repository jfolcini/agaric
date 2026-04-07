-- P-1: Add missing index on block_links.source_id.
-- Multiple queries in cache.rs and backlink_query.rs filter on source_id.
-- Without this index, those queries perform full table scans.
CREATE INDEX IF NOT EXISTS idx_block_links_source ON block_links(source_id);
