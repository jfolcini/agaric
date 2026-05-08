-- PEND-35 Tier 3.1: retire the expression index from migration 0003
-- now that all four query sites read the native `op_log.block_id`
-- column added by migration 0030. The denormalized column is covered
-- by `idx_op_log_block_id` (also from 0030), so this index is now
-- pure overhead.

DROP INDEX IF EXISTS idx_op_log_payload_block_id;
