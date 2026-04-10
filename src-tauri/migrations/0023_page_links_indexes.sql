-- P-15: Optimize list_page_links query performance.
-- Partial index on pages-only blocks accelerates the JOIN filters.
CREATE INDEX IF NOT EXISTS idx_blocks_page_alive
    ON blocks(id)
    WHERE block_type = 'page' AND deleted_at IS NULL;
