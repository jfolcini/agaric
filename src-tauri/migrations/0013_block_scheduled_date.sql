-- Add scheduled_date column (mirrors due_date pattern from 0012)
ALTER TABLE blocks ADD COLUMN scheduled_date TEXT;

CREATE INDEX IF NOT EXISTS idx_blocks_scheduled ON blocks(scheduled_date) WHERE scheduled_date IS NOT NULL;

-- Backfill from block_properties where key = 'scheduled'
UPDATE blocks
SET scheduled_date = (
    SELECT bp.value_date
    FROM block_properties bp
    WHERE bp.block_id = blocks.id AND bp.key = 'scheduled'
)
WHERE id IN (
    SELECT block_id FROM block_properties WHERE key = 'scheduled' AND value_date IS NOT NULL
);

-- Remove migrated property rows
DELETE FROM block_properties WHERE key = 'scheduled' AND value_date IS NOT NULL;
