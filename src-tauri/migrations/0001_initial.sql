-- Block Notes: Initial Schema
-- See ADR-05 for design rationale

-- Core block table: everything is a block
CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY NOT NULL,              -- ULID
    block_type TEXT NOT NULL DEFAULT 'content', -- 'content' | 'tag' | 'page'
    content TEXT,
    parent_id TEXT REFERENCES blocks(id),       -- null = top-level
    position INTEGER,                           -- 1-based among siblings; null for tags
    deleted_at TEXT,                             -- ISO 8601; soft delete
    archived_at TEXT,
    is_conflict INTEGER NOT NULL DEFAULT 0,
    conflict_source TEXT REFERENCES blocks(id)
);

-- Tag associations
CREATE TABLE IF NOT EXISTS block_tags (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    tag_id TEXT NOT NULL REFERENCES blocks(id),  -- must be block_type = 'tag'
    PRIMARY KEY (block_id, tag_id)
);

-- Typed properties on blocks
CREATE TABLE IF NOT EXISTS block_properties (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    key TEXT NOT NULL,
    value_text TEXT,
    value_num REAL,
    value_date TEXT,                              -- ISO 8601
    value_ref TEXT REFERENCES blocks(id),
    PRIMARY KEY (block_id, key)
);

-- Materializer-maintained link index (derived from [[ULID]] tokens in content)
CREATE TABLE IF NOT EXISTS block_links (
    source_id TEXT NOT NULL REFERENCES blocks(id),
    target_id TEXT NOT NULL REFERENCES blocks(id),
    PRIMARY KEY (source_id, target_id)
);

-- File attachments
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,                -- ULID
    block_id TEXT NOT NULL REFERENCES blocks(id),
    mime_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    fs_path TEXT NOT NULL,                        -- relative path alongside SQLite file
    created_at TEXT NOT NULL,                     -- ISO 8601
    deleted_at TEXT
);

-- Operation log: strictly append-only
CREATE TABLE IF NOT EXISTS op_log (
    device_id TEXT NOT NULL,                      -- originating device UUID
    seq INTEGER NOT NULL,                         -- per-device monotonic sequence number
    PRIMARY KEY (device_id, seq),
    parent_seqs TEXT,                             -- JSON: [[device_id, seq], ...] or null
    hash TEXT NOT NULL,                           -- blake3 hash
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL,                        -- JSON
    created_at TEXT NOT NULL                      -- ISO 8601
);

-- Draft autosave (mutable scratch space — the ONLY mutable table besides caches)
CREATE TABLE IF NOT EXISTS block_drafts (
    block_id TEXT PRIMARY KEY NOT NULL,           -- ULID
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL                      -- ISO 8601
);

-- Op log compaction snapshots
CREATE TABLE IF NOT EXISTS log_snapshots (
    id TEXT PRIMARY KEY NOT NULL,                 -- ULID
    status TEXT NOT NULL,                          -- 'pending' | 'complete'
    up_to_hash TEXT NOT NULL,
    up_to_seqs TEXT NOT NULL,                     -- JSON: { device_id: seq }
    data BLOB NOT NULL                            -- zstd-compressed CBOR
);

-- Sync peer tracking
CREATE TABLE IF NOT EXISTS peer_refs (
    peer_id TEXT PRIMARY KEY NOT NULL,            -- device UUID of remote peer
    last_hash TEXT,
    last_sent_hash TEXT,
    synced_at TEXT,
    reset_count INTEGER NOT NULL DEFAULT 0,
    last_reset_at TEXT
);

-- Performance caches

CREATE TABLE IF NOT EXISTS tags_cache (
    tag_id TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id),
    name TEXT NOT NULL UNIQUE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages_cache (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id),
    title TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agenda_cache (
    date TEXT NOT NULL,                           -- DATE format YYYY-MM-DD
    block_id TEXT NOT NULL REFERENCES blocks(id),
    source TEXT NOT NULL,                          -- 'property:<key>' or 'tag:<tag_id>'
    PRIMARY KEY (date, block_id)
);

-- Indexes (ADR-05)
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(block_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_block_links_target ON block_links(target_id);
CREATE INDEX IF NOT EXISTS idx_block_props_date ON block_properties(value_date) WHERE value_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_op_log_created ON op_log(created_at);
CREATE INDEX IF NOT EXISTS idx_agenda_date ON agenda_cache(date);
