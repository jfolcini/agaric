-- Add fixed fields for todo state, priority, and due date directly on blocks.
-- These duplicate data previously stored only in block_properties for fast
-- indexed access without a JOIN.

ALTER TABLE blocks ADD COLUMN todo_state TEXT;
ALTER TABLE blocks ADD COLUMN priority TEXT;
ALTER TABLE blocks ADD COLUMN due_date TEXT;

CREATE INDEX idx_blocks_todo ON blocks(todo_state) WHERE todo_state IS NOT NULL;
CREATE INDEX idx_blocks_due ON blocks(due_date) WHERE due_date IS NOT NULL;

-- Backfill from block_properties for non-page blocks.
-- The app uses key='todo' (not 'todo_state'), 'priority', and 'due' for dates.
UPDATE blocks SET todo_state = (
    SELECT bp.value_text FROM block_properties bp
    WHERE bp.block_id = blocks.id AND bp.key = 'todo'
) WHERE blocks.todo_state IS NULL AND blocks.block_type != 'page';

UPDATE blocks SET priority = (
    SELECT bp.value_text FROM block_properties bp
    WHERE bp.block_id = blocks.id AND bp.key = 'priority'
) WHERE blocks.priority IS NULL AND blocks.block_type != 'page';

UPDATE blocks SET due_date = (
    SELECT COALESCE(bp.value_date, bp.value_text) FROM block_properties bp
    WHERE bp.block_id = blocks.id AND bp.key = 'due'
) WHERE blocks.due_date IS NULL AND blocks.block_type != 'page';

-- Remove migrated rows from block_properties.
DELETE FROM block_properties
WHERE key IN ('todo', 'priority', 'due')
  AND block_id IN (SELECT id FROM blocks WHERE block_type != 'page');
