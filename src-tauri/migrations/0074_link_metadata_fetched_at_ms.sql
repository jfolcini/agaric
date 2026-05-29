-- Issue #109 Phase 2: migrate `link_metadata.fetched_at` from TEXT
-- (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC), the canonical
-- timestamp encoding codified in migrations/AGENTS.md (Phase 1, migration
-- via `crate::db::now_ms()`).
--
-- `link_metadata` is a device-local, NOT-synced cache (migration 0026) with
-- no foreign keys, no triggers, and no indexes beyond its `url` PRIMARY KEY,
-- so this is the lightest table in the Phase 2 inventory — picked first per
-- the issue's least-hot-first ordering to establish the migration shape.
--
-- SQLite has no `ALTER TABLE ... ALTER COLUMN`, so this uses the canonical
-- table-rebuild recipe (in-repo precedent: 0061/0062/0073). The new column
-- is `INTEGER NOT NULL CHECK (fetched_at >= 0)` per the convention, and the
-- rebuilt table gains `STRICT` (migrations/AGENTS.md requirement for new
-- CREATEs; the data is already type-clean — every writer binds through sqlx).
--
-- Backfill conversion: `fetched_at` is RFC 3339 TEXT (e.g.
-- "2026-05-29T12:00:00.000Z"). `julianday()` parses the full ISO-8601 form
-- including the 'T' separator and 'Z' suffix and yields a fractional Julian
-- day, so `(julianday(x) - 2440587.5) * 86400000` gives epoch milliseconds
-- with sub-second precision preserved (unlike `strftime('%s', x) * 1000`,
-- which truncates the fractional seconds). `ROUND` then `CAST` to land on an
-- integer millisecond. A row whose `fetched_at` fails to parse yields NULL,
-- which violates the NOT NULL on copy and aborts the migration with the
-- original table intact (fail-loud) — acceptable for a regenerable cache.

CREATE TABLE _new_link_metadata (
    url           TEXT    PRIMARY KEY,
    title         TEXT,
    favicon_url   TEXT,
    description   TEXT,
    -- milliseconds since UNIX epoch (UTC); written via crate::db::now_ms()
    fetched_at    INTEGER NOT NULL CHECK (fetched_at >= 0),
    auth_required INTEGER NOT NULL DEFAULT 0,
    not_found     INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO _new_link_metadata
    (url, title, favicon_url, description, fetched_at, auth_required, not_found)
    SELECT url, title, favicon_url, description,
           CAST(ROUND((julianday(fetched_at) - 2440587.5) * 86400000.0) AS INTEGER),
           auth_required, not_found
    FROM link_metadata;

DROP TABLE link_metadata;
ALTER TABLE _new_link_metadata RENAME TO link_metadata;
