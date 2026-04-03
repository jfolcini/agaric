-- Seed repeat-related property definitions for discoverability (#644)
-- repeat-origin stores a block ref but uses 'text' type since the
-- property_definitions CHECK constraint has no 'ref' value_type.
-- At runtime the value is stored in block_properties.value_ref.
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at)
VALUES
    ('repeat', 'text', NULL, '2026-01-01T00:00:00.000Z'),
    ('repeat-until', 'date', NULL, '2026-01-01T00:00:00.000Z'),
    ('repeat-count', 'number', NULL, '2026-01-01T00:00:00.000Z'),
    ('repeat-seq', 'number', NULL, '2026-01-01T00:00:00.000Z'),
    ('repeat-origin', 'text', NULL, '2026-01-01T00:00:00.000Z');
