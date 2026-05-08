-- Partial index for journal-page date lookups.
--
-- Journal pages are `block_type = 'page'` blocks whose `content` is a
-- `YYYY-MM-DD` string. Two queries need to locate them efficiently:
--
-- 1. `get_journal_page_by_date` — exact-match lookup for auto-create
--    guard (does a page for 2026-05-07 already exist?).
-- 2. `list_journal_page_dates` — list all date-formatted pages for
--    calendar highlighting.
--
-- The partial predicate `content LIKE '____-__-__'` is matched by a
-- prefix scan on the `content` column (SQLite's LIKE optimisation
-- applies when the pattern starts with non-wildcard characters). The
-- `block_type = 'page'` guard in the query plus this index keeps the
-- scan scoped to a small subset of the table — essential when the
-- block count grows past 100K.
--
-- Index migrations don't require STRICT (STRICT applies to CREATE
-- TABLE only). No table is created or modified here.

CREATE INDEX IF NOT EXISTS idx_blocks_journal_date
    ON blocks(content)
    WHERE block_type = 'page' AND content LIKE '____-__-__';
