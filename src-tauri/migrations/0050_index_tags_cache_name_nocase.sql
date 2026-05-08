-- PEND-35 Tier 3.3: NOCASE index on tags_cache.name to support the
-- case-insensitive LIKE prefix query in `tag_query::query`. Every
-- keystroke of every tag picker (SearchPanel, TagFilterPanel,
-- TagValuePicker, HasTagFilterForm, useBlockResolve, agenda-filters)
-- runs this query, so the BINARY-collation full-scan was a meaningful
-- per-keystroke cost.
--
-- SQLite default LIKE is case-insensitive on ASCII, so the existing
-- BINARY index from the UNIQUE constraint can't satisfy the query.
-- Mirrors the NOCASE pattern used by `idx_page_aliases_alias` in
-- migration 0015.

CREATE INDEX IF NOT EXISTS idx_tags_cache_name_nocase ON tags_cache(name COLLATE NOCASE);
