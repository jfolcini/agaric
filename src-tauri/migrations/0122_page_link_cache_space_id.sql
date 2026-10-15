-- #5426: the space-scoped graph read (`list_page_links`) checked both ends of
-- every edge against the space's pages. `space_id` carries that answer on the
-- row, the way 0096 carries liveness: the space both pages share, NULL for an
-- edge between spaces, an edge with a space-less end, or an end that is not a
-- page. It depends on pages' `space_id` alone, and every path that changes
-- one (a `space` op, inbound sync, purging the space) rebuilds the cache.
-- Every writer in `agaric-store/src/cache/page_links.rs` computes the same
-- expression. No FK, like `tags_cache.space_id` (0121): it mirrors
-- `blocks.space_id` and every rebuild rewrites it.
--
-- mock-unaffected: the mock stores no page_link_cache; its list_page_links derives edges from blocks on every read and checks both ends' spaces there.

ALTER TABLE page_link_cache ADD COLUMN space_id TEXT;

UPDATE page_link_cache SET space_id = (
    SELECT sp.space_id
      FROM blocks sp
      JOIN blocks tb ON tb.id = page_link_cache.target_page_id
     WHERE sp.id = page_link_cache.source_page_id
       AND sp.block_type = 'page'
       AND tb.block_type = 'page'
       AND sp.space_id = tb.space_id
);

-- The scoped read is a range of this index, already in its ORDER BY. The flags
-- trail the key although the WHERE pins them: SQLite does not read a partial
-- index's WHERE terms as column values, so without them every row costs a
-- table lookup.
CREATE INDEX idx_page_link_cache_space
    ON page_link_cache(space_id, edge_count DESC, source_page_id, target_page_id,
                       src_deleted, tgt_deleted, tgt_is_page)
    WHERE src_deleted = 0 AND tgt_deleted = 0 AND tgt_is_page = 1;

-- Its one reader, the unscoped graph read, went with #5415.
DROP INDEX idx_page_link_cache_live;
