-- UX-250: Derived-state table tracking inline `#[ULID]` tag references
-- inside block content.
--
-- Explicit tag associations live in `block_tags` (written by add_tag /
-- remove_tag ops). Inline `#[ULID]` references found inside content blocks
-- live here, populated incrementally by the materializer on content edits
-- and on boot if the table is empty. The two tables stay separate so
-- explicit-vs-inline origin is preserved, but tags-view counts and the
-- tag_query resolver UNION them when looking up "which blocks reference
-- this tag".
--
-- No SQL backfill: SQLite lacks regex. A Rust-side materializer task
-- (`RebuildBlockTagRefsCache`) is enqueued at boot if the table is empty.
CREATE TABLE IF NOT EXISTS block_tag_refs (
    source_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, tag_id)
);

-- Mirror `idx_block_links_target` — answers "which blocks reference this
-- tag?" without a full scan.
CREATE INDEX IF NOT EXISTS idx_block_tag_refs_tag ON block_tag_refs(tag_id);
