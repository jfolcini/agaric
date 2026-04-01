-- Expression index to avoid full-table scans on json_extract queries.
-- Covers the 14 instances of json_extract(payload, '$.block_id') across
-- recovery.rs, commands.rs, reverse.rs, pagination.rs, dag.rs.
CREATE INDEX IF NOT EXISTS idx_op_log_payload_block_id
    ON op_log(json_extract(payload, '$.block_id'));
