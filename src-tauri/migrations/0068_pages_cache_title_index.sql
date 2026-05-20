-- PEND-73 Phase 1.B2 — index pages_cache.title for case-insensitive lookups.
--
-- 0061 explicitly noted "no indexes on pages_cache beyond the PRIMARY KEY"
-- on the bet that personal-notes scale would not need one. With PEND-54
-- chips now making path-glob filtering a hot path, every page-name glob
-- query is a full table scan over `pages_cache`. Add a case-insensitive
-- index on `title` matching the existing `idx_tags_cache_name_nocase`
-- convention (from migration 0061) so `LOWER(title) GLOB ?` and
-- `title COLLATE NOCASE LIKE ?` queries can use the index.
--
-- `IF NOT EXISTS` mirrors every other index migration in this directory.

CREATE INDEX IF NOT EXISTS idx_pages_cache_title_nocase
    ON pages_cache(title COLLATE NOCASE);
