-- Add denormalized page_id column: nearest ancestor with block_type = 'page'.
-- For page blocks, page_id = self. For content blocks, page_id = nearest page ancestor.
-- For tags (top-level, no parent), page_id = NULL.
ALTER TABLE blocks ADD COLUMN page_id TEXT REFERENCES blocks(id);

-- Backfill page_id using recursive CTE.
-- Walk parent_id chain until finding a block with block_type = 'page'.
WITH RECURSIVE ancestors(block_id, cur_id, cur_type) AS (
    -- Base: each block starts at itself
    SELECT b.id, b.id, b.block_type FROM blocks b
    UNION ALL
    -- Recurse: move to the parent of cur_id
    SELECT a.block_id, parent.id, parent.block_type
    FROM ancestors a
    JOIN blocks child ON child.id = a.cur_id
    JOIN blocks parent ON parent.id = child.parent_id
    WHERE a.cur_type != 'page'
),
page_ancestors AS (
    -- For each block, find the first ancestor (or self) that is a page
    SELECT block_id, cur_id AS page_id
    FROM ancestors
    WHERE cur_type = 'page'
)
UPDATE blocks SET page_id = (
    SELECT pa.page_id FROM page_ancestors pa WHERE pa.block_id = blocks.id
);

CREATE INDEX idx_blocks_page_id ON blocks(page_id);
