-- #5237 — a tag name is unique per SPACE, not per vault: `todo` in Work and
-- `todo` in Personal are two tags, and the 0061 `UNIQUE (name)` let the cache
-- hold only one of them. `space_id` mirrors `blocks.space_id` (NULL for an
-- unscoped tag) and is maintained by the same rebuild as `usage_count`, so it
-- carries no FK. `_new_<table>` rebuild: a UNIQUE constraint cannot be altered
-- in place; nothing references `tags_cache`, so there is no child to preserve.
CREATE TABLE _new_tags_cache (
    tag_id      TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    space_id    TEXT,
    name        TEXT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    UNIQUE (space_id, name)
) STRICT;

-- Recompute from the live blocks rather than copy: the rows the vault-wide
-- constraint dropped must exist now, not after the next rebuild. The count is
-- `DESIRED_TAGS_SQL`'s (`agaric-store/src/cache/tags.rs`); `OR IGNORE` +
-- `ORDER BY b.id` keep the smallest-id tag of a byte-identical same-space pair
-- (#5236's duplicates), and the next `RebuildTagsCache` applies the normalized
-- dedup on top.
INSERT OR IGNORE INTO _new_tags_cache (tag_id, space_id, name, usage_count, updated_at)
SELECT b.id,
       b.space_id,
       b.content,
       COALESCE(t.cnt, 0),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM blocks b
  LEFT JOIN (
      SELECT tag_id, COUNT(*) AS cnt FROM (
          SELECT bt.tag_id, bt.block_id
            FROM block_tags bt
            JOIN blocks blk ON blk.id = bt.block_id
           WHERE blk.deleted_at IS NULL
          UNION
          SELECT btr.tag_id, btr.source_id AS block_id
            FROM block_tag_refs btr
            JOIN blocks blk ON blk.id = btr.source_id
           WHERE blk.deleted_at IS NULL
      )
      GROUP BY tag_id
  ) t ON t.tag_id = b.id
 WHERE b.block_type = 'tag'
   AND b.deleted_at IS NULL
   AND b.content IS NOT NULL
 ORDER BY b.id ASC;

DROP TABLE tags_cache;
ALTER TABLE _new_tags_cache RENAME TO tags_cache;

-- The 0050 prefix index went with the old table; the UNIQUE autoindex is
-- BINARY-collated and cannot serve `name LIKE ?`.
CREATE INDEX IF NOT EXISTS idx_tags_cache_name_nocase
    ON tags_cache(name COLLATE NOCASE);
