-- FEAT-3 Phase 1: Spaces partition pages into user-defined contexts.
-- Adds the two marker property types + an index on the `space` ref lookup.
-- Seeded "Personal" + "Work" space blocks are NOT created here — a boot-time
-- Rust bootstrap emits the ops so op_log stays append-only.
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES
    ('space',    'ref',  NULL, '2026-04-23T00:00:00Z'),
    ('is_space', 'text', NULL, '2026-04-23T00:00:00Z');

CREATE INDEX IF NOT EXISTS idx_block_properties_space
    ON block_properties(value_ref)
    WHERE key = 'space';
