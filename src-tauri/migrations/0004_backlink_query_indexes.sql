-- Index for property key lookups (PropertyIsSet, PropertyIsEmpty filters)
CREATE INDEX IF NOT EXISTS idx_block_props_key ON block_properties(key, block_id);
-- Index for key+text value lookups (PropertyText filter)
CREATE INDEX IF NOT EXISTS idx_block_props_key_text ON block_properties(key, value_text) WHERE value_text IS NOT NULL;
-- Index for key+num value lookups (PropertyNum filter)
CREATE INDEX IF NOT EXISTS idx_block_props_key_num ON block_properties(key, value_num) WHERE value_num IS NOT NULL;
