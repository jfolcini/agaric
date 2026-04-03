-- Seed built-in property definitions for block fixed fields and standard properties.
-- Extends the initial seeds (status, due, url) from migration 0011.
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at)
VALUES
    ('todo_state', 'select', '["TODO","DOING","DONE"]', '2026-01-01T00:00:00.000Z'),
    ('priority', 'select', '["1","2","3"]', '2026-01-01T00:00:00.000Z'),
    ('due_date', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('scheduled_date', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('created_at', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('completed_at', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('effort', 'select', '["15m","30m","1h","2h","4h","1d"]', '2026-01-01T00:00:00.000Z'),
    ('assignee', 'text', NULL, '2026-01-01T00:00:00.000Z'),
    ('location', 'text', NULL, '2026-01-01T00:00:00.000Z');
