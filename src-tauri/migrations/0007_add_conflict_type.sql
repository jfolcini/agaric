-- Track the type of conflict for conflict-copy blocks.
-- Values: 'Text', 'Property', 'Move', 'DeleteEdit'. NULL for non-conflict blocks.
ALTER TABLE blocks ADD COLUMN conflict_type TEXT;
