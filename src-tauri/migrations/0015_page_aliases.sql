-- Page aliases: alternative names for pages (synonyms, abbreviations).
CREATE TABLE IF NOT EXISTS page_aliases (
    page_id TEXT NOT NULL REFERENCES blocks(id),
    alias TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (page_id, alias)
);

-- Unique index on alias for fast lookup + uniqueness enforcement
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_aliases_alias ON page_aliases(alias COLLATE NOCASE);

-- Index for finding all aliases of a page
CREATE INDEX IF NOT EXISTS idx_page_aliases_page ON page_aliases(page_id);
