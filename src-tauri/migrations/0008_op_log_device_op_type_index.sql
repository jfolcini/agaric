-- Composite index for sync protocol queries filtering on (device_id, op_type).
-- Covers 8+ queries in sync_protocol.rs: edit_block, set_property, move_block,
-- and delete_block divergence detection during merge.
CREATE INDEX IF NOT EXISTS idx_op_log_device_op_type
    ON op_log(device_id, op_type);
