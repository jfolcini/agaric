-- P-4: Precomputed tag inheritance cache.
-- Replaces the recursive CTE in tag_query.rs for include_inherited=true queries.
-- Maintained incrementally by command handlers and the materializer.

-- Table stores only INHERITED tags (NOT direct tags — those stay in block_tags).
-- inherited_from = the ancestor block_id that directly holds the tag in block_tags.
CREATE TABLE IF NOT EXISTS block_tag_inherited (
    block_id      TEXT NOT NULL REFERENCES blocks(id),
    tag_id        TEXT NOT NULL REFERENCES blocks(id),
    inherited_from TEXT NOT NULL REFERENCES blocks(id),
    PRIMARY KEY (block_id, tag_id)
);

-- Main query path: "which blocks inherit tag X?"
CREATE INDEX IF NOT EXISTS idx_bti_tag ON block_tag_inherited(tag_id);

-- Cleanup path: "remove all rows inherited from ancestor X with tag Y"
CREATE INDEX IF NOT EXISTS idx_bti_inherited_from_tag ON block_tag_inherited(inherited_from, tag_id);

-- Backfill from existing data: for every (block, tag) in block_tags,
-- find all descendants of that block and insert inherited entries.
INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from)
WITH RECURSIVE descendant_tags AS (
    -- Base: direct children of each tagged block
    SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from
    FROM block_tags bt
    JOIN blocks tagged ON tagged.id = bt.block_id
    JOIN blocks b ON b.parent_id = bt.block_id
    WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0
      AND b.deleted_at IS NULL AND b.is_conflict = 0

    UNION ALL

    -- Recursive: deeper descendants
    SELECT b.id AS block_id, dt.tag_id, dt.inherited_from
    FROM descendant_tags dt
    JOIN blocks b ON b.parent_id = dt.block_id
    WHERE b.deleted_at IS NULL AND b.is_conflict = 0
)
SELECT block_id, tag_id, inherited_from FROM descendant_tags;
