-- Property definitions: schema registry for typed block properties (ADR-22).
CREATE TABLE IF NOT EXISTS property_definitions (
    key TEXT PRIMARY KEY NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select')),
    options TEXT,          -- JSON array for select-type definitions, NULL otherwise
    created_at TEXT NOT NULL  -- ISO 8601
);

-- Seed default definitions (#550)
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at)
VALUES
    ('status', 'select', '["active","paused","done","archived"]', '2026-01-01T00:00:00.000Z'),
    ('due', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('url', 'text', NULL, '2026-01-01T00:00:00.000Z');
