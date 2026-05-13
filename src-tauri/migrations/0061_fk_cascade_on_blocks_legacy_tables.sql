-- H7 (sql-audit-2026-05-09): add `ON DELETE CASCADE` (or `SET NULL` for
-- soft pointers) to every FK referencing `blocks(id)` on the ten legacy
-- tables that pre-date the cascade convention. Newer tables
-- (`block_tag_refs` migration 0034, `block_drafts` migration 0038) already
-- declare CASCADE; this migration brings the legacy tables in line so the
-- schema enforces "if the parent block row is hard-deleted, derived state
-- pointing at it must also go".
--
-- Background: SQLite does not support `ALTER TABLE ... ADD CONSTRAINT`
-- nor in-place modification of an existing FK clause, so each affected
-- table is rebuilt via the canonical 12-step recipe from
-- https://www.sqlite.org/lang_altertable.html:
--   1. (skipped) `PRAGMA foreign_keys = OFF` — no-op inside a transaction
--      per the SQLite docs; sqlx wraps every migration file in its own tx
--      so issuing the PRAGMA here would do nothing.
--   2. Pre-cleanup: delete pre-existing orphan rows whose FK target no
--      longer exists in `blocks` — otherwise the INSERT into the new
--      (CASCADE-FK) table would fail with a FOREIGN KEY constraint
--      violation. Precedent: migration 0038 used the same pattern for
--      `block_drafts`.
--   3. `CREATE TABLE _new_<table>` with the CASCADE / SET NULL clauses.
--   4. `INSERT INTO _new_<table> SELECT ... FROM <table>`.
--   5. `DROP TABLE <table>` — also drops every index on the old table.
--   6. `ALTER TABLE _new_<table> RENAME TO <table>`.
--   7. Recreate every live index against the renamed table. Index
--      lists below are reconciled against the full migration history
--      0001..0060 so any index dropped along the way (notably
--      `idx_block_props_key_num` and `idx_page_aliases_page` in 0045,
--      and `idx_agenda_date` in 0045) is NOT recreated.
--
-- Per-column cascade rationale (semantic check from sql-audit-2026-05-09):
--   * `block_id` columns (everywhere) — the row is derived state owned
--     by the block; hard-deleting the block must drop the derived row.
--     CASCADE.
--   * `tag_id` columns (block_tags, tags_cache, block_tag_inherited) —
--     the row associates a block with a tag block; if the tag block is
--     hard-deleted, the association is meaningless. CASCADE.
--   * `block_links.source_id` / `target_id` — link-graph edges,
--     fully derived from content. CASCADE.
--   * `block_tag_inherited.inherited_from` — bookkeeping pointer to the
--     ancestor that holds the direct tag; if that ancestor is gone the
--     inherited row is invalid. CASCADE.
--   * `block_properties.value_ref` — a soft pointer to ANOTHER block
--     (the property belongs to `block_id`, not `value_ref`). Hard-
--     deleting the referenced block must NOT delete the property row
--     on the owning block. SET NULL. This matches the existing Rust
--     cascade in `commands/blocks/crud.rs` (`UPDATE block_properties
--     SET value_ref = NULL WHERE value_ref IN (SELECT id FROM
--     descendants)`).
--   * `page_aliases.page_id`, `tags_cache.tag_id`, `pages_cache.page_id`,
--     `agenda_cache.block_id`, `projected_agenda_cache.block_id` —
--     pure cache / alias rows, derived state. CASCADE.
--
-- Notes on PRAGMA `foreign_keys` and migration safety:
--   sqlx wraps each `.sql` migration in a BEGIN/COMMIT transaction.
--   `PRAGMA foreign_keys` cannot change inside a tx, so the pragma stays
--   at its `init_pool` value (`ON`) for the duration of this migration.
--   That means the INSERTs into the new tables enforce FKs as they run —
--   which is why we do an orphan-cleanup DELETE first against the
--   *new-FK-shape* rules. The cascade-vs-set-null semantics line up with
--   the orphan-cleanup choice: rows where the cascade target is
--   missing are deleted; rows where the SET-NULL target is missing
--   (only `block_properties.value_ref`) get NULL'd, not deleted.
--
-- Performance note (audit risk-mitigation item):
--   `block_tags` and `block_properties` are the two largest tables here.
--   At 100k pages / a few million blocks, each rebuild is a single
--   `INSERT INTO _new SELECT ... FROM old` — SQLite's bulk copy path,
--   ANALYZEd at sub-30s on the target scale.  Index recreation runs in
--   the same transaction.

-- =====================================================================
-- 1. block_tags
-- =====================================================================
DELETE FROM block_tags
WHERE block_id NOT IN (SELECT id FROM blocks)
   OR tag_id   NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_block_tags (
    block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    PRIMARY KEY (block_id, tag_id)
) STRICT;

INSERT INTO _new_block_tags (block_id, tag_id)
    SELECT block_id, tag_id FROM block_tags;

DROP TABLE block_tags;
ALTER TABLE _new_block_tags RENAME TO block_tags;

CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag_id);

-- =====================================================================
-- 2. block_properties  (block_id CASCADE, value_ref SET NULL)
-- =====================================================================
DELETE FROM block_properties
WHERE block_id NOT IN (SELECT id FROM blocks);

UPDATE block_properties
SET value_ref = NULL
WHERE value_ref IS NOT NULL
  AND value_ref NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_block_properties (
    block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_text TEXT,
    value_num  REAL,
    value_date TEXT,
    value_ref  TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    value_bool INTEGER CHECK (value_bool IS NULL OR value_bool IN (0, 1)),
    PRIMARY KEY (block_id, key)
) STRICT;

INSERT INTO _new_block_properties
    (block_id, key, value_text, value_num, value_date, value_ref, value_bool)
    SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool
    FROM block_properties;

DROP TABLE block_properties;
ALTER TABLE _new_block_properties RENAME TO block_properties;

CREATE INDEX IF NOT EXISTS idx_block_props_key
    ON block_properties(key, block_id);
CREATE INDEX IF NOT EXISTS idx_block_props_key_text
    ON block_properties(key, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_props_date
    ON block_properties(value_date) WHERE value_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_key_value_num
    ON block_properties(key, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_value_bool
    ON block_properties(value_bool) WHERE value_bool IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_properties_space_covering
    ON block_properties(value_ref, block_id) WHERE key = 'space';

-- =====================================================================
-- 3. block_links
-- =====================================================================
DELETE FROM block_links
WHERE source_id NOT IN (SELECT id FROM blocks)
   OR target_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_block_links (
    source_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    PRIMARY KEY (source_id, target_id)
) STRICT;

INSERT INTO _new_block_links (source_id, target_id)
    SELECT source_id, target_id FROM block_links;

DROP TABLE block_links;
ALTER TABLE _new_block_links RENAME TO block_links;

CREATE INDEX IF NOT EXISTS idx_block_links_target ON block_links(target_id);
CREATE INDEX IF NOT EXISTS idx_block_links_source ON block_links(source_id);

-- =====================================================================
-- 4. attachments
-- =====================================================================
DELETE FROM attachments
WHERE block_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_attachments (
    id          TEXT PRIMARY KEY NOT NULL,
    block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    mime_type   TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    fs_path     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    deleted_at  TEXT
) STRICT;

INSERT INTO _new_attachments
    (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at)
    SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at, deleted_at
    FROM attachments;

DROP TABLE attachments;
ALTER TABLE _new_attachments RENAME TO attachments;

CREATE INDEX IF NOT EXISTS idx_attachments_block ON attachments(block_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_fs_path_unique
    ON attachments(fs_path) WHERE deleted_at IS NULL;

-- =====================================================================
-- 5. tags_cache
-- =====================================================================
DELETE FROM tags_cache
WHERE tag_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_tags_cache (
    tag_id      TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    name        TEXT NOT NULL UNIQUE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
) STRICT;

INSERT INTO _new_tags_cache (tag_id, name, usage_count, updated_at)
    SELECT tag_id, name, usage_count, updated_at FROM tags_cache;

DROP TABLE tags_cache;
ALTER TABLE _new_tags_cache RENAME TO tags_cache;

CREATE INDEX IF NOT EXISTS idx_tags_cache_name_nocase
    ON tags_cache(name COLLATE NOCASE);

-- =====================================================================
-- 6. pages_cache
-- =====================================================================
DELETE FROM pages_cache
WHERE page_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_pages_cache (
    page_id    TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

INSERT INTO _new_pages_cache (page_id, title, updated_at)
    SELECT page_id, title, updated_at FROM pages_cache;

DROP TABLE pages_cache;
ALTER TABLE _new_pages_cache RENAME TO pages_cache;

-- (no indexes on pages_cache beyond the PRIMARY KEY)

-- =====================================================================
-- 7. agenda_cache
-- =====================================================================
DELETE FROM agenda_cache
WHERE block_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_agenda_cache (
    date     TEXT NOT NULL,
    block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    source   TEXT NOT NULL,
    PRIMARY KEY (date, block_id)
) STRICT;

INSERT INTO _new_agenda_cache (date, block_id, source)
    SELECT date, block_id, source FROM agenda_cache;

DROP TABLE agenda_cache;
ALTER TABLE _new_agenda_cache RENAME TO agenda_cache;

-- (idx_agenda_date was dropped in 0045 as redundant with the PK leading
--  column `date`; do not recreate.)

-- =====================================================================
-- 8. page_aliases
-- =====================================================================
DELETE FROM page_aliases
WHERE page_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_page_aliases (
    page_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    alias   TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (page_id, alias)
) STRICT;

INSERT INTO _new_page_aliases (page_id, alias)
    SELECT page_id, alias FROM page_aliases;

DROP TABLE page_aliases;
ALTER TABLE _new_page_aliases RENAME TO page_aliases;

CREATE UNIQUE INDEX IF NOT EXISTS idx_page_aliases_alias
    ON page_aliases(alias COLLATE NOCASE);

-- (idx_page_aliases_page was dropped in 0045; do not recreate.)

-- =====================================================================
-- 9. block_tag_inherited
-- =====================================================================
DELETE FROM block_tag_inherited
WHERE block_id       NOT IN (SELECT id FROM blocks)
   OR tag_id         NOT IN (SELECT id FROM blocks)
   OR inherited_from NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_block_tag_inherited (
    block_id       TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag_id         TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    inherited_from TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    PRIMARY KEY (block_id, tag_id)
) STRICT;

INSERT INTO _new_block_tag_inherited (block_id, tag_id, inherited_from)
    SELECT block_id, tag_id, inherited_from FROM block_tag_inherited;

DROP TABLE block_tag_inherited;
ALTER TABLE _new_block_tag_inherited RENAME TO block_tag_inherited;

CREATE INDEX IF NOT EXISTS idx_bti_tag
    ON block_tag_inherited(tag_id);
CREATE INDEX IF NOT EXISTS idx_bti_inherited_from_tag
    ON block_tag_inherited(inherited_from, tag_id);

-- =====================================================================
-- 10. projected_agenda_cache
-- =====================================================================
DELETE FROM projected_agenda_cache
WHERE block_id NOT IN (SELECT id FROM blocks);

CREATE TABLE _new_projected_agenda_cache (
    block_id       TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    projected_date TEXT NOT NULL,
    source         TEXT NOT NULL,
    PRIMARY KEY (block_id, projected_date, source)
) STRICT;

INSERT INTO _new_projected_agenda_cache (block_id, projected_date, source)
    SELECT block_id, projected_date, source FROM projected_agenda_cache;

DROP TABLE projected_agenda_cache;
ALTER TABLE _new_projected_agenda_cache RENAME TO projected_agenda_cache;

CREATE INDEX IF NOT EXISTS idx_projected_agenda_date
    ON projected_agenda_cache(projected_date);
