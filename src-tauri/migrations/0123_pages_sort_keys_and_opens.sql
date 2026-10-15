-- #5371 — every Pages sort orders the whole space behind a keyset cursor, so
-- each sort key is a column the query reads instead of a JS re-sort of the
-- loaded window.
--
-- `title_sort_key` is the Alphabetical key: the title NFKD-decomposed,
-- combining marks stripped, lowercased (`agaric_core::title_sort`), compared
-- in BINARY order. `last_edited_ms` is the Last-edited key: the newest op on
-- the page or any block on it, else the page's ULID creation time; the
-- materializer only ever raises it, so op-log compaction cannot take it back
-- (#5286). SQLite cannot compute an NFKD key, so neither column is backfilled
-- here: the page-row rebuild (`agaric_store::cache::pages`) fills every row
-- still at the defaults, and boot schedules it while one exists.
ALTER TABLE pages_cache
    ADD COLUMN title_sort_key TEXT NOT NULL DEFAULT '';

ALTER TABLE pages_cache
    ADD COLUMN last_edited_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_edited_ms >= 0);

-- The Last-opened key: when this device last opened the page. Device-local
-- like `block_drafts`: no op type, no Loro state, so nothing syncs or exports
-- it, and a purge drops the row with its page.
CREATE TABLE page_opens (
    page_id   TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    opened_ms INTEGER NOT NULL CHECK (opened_ms >= 0)
) STRICT;
