-- FEAT-4h (slice 1): add `origin` column to op_log for agent-attribution.
--
-- The column records who initiated each op:
--   - 'user'            — frontend-invoked commands (the default).
--   - 'agent:<name>'    — MCP tool-call invocations (FEAT-4h v2 RW server).
--                         `<name>` is the self-reported `clientInfo.name`
--                         from the MCP handshake, carried through the
--                         `mcp::actor::ACTOR` task-local.
--
-- Existing rows backfill to 'user' via the column default — the op_log is
-- append-only per AGENTS.md invariant #1, and every pre-FEAT-4h op was
-- written by a frontend user (no agent path existed yet). Future MCP write
-- tools (FEAT-4h slice 2+) will read `current_actor().origin_tag()` at the
-- op-append call site in `op_log::append_local_op_in_tx` and emit
-- 'agent:<name>' instead.
--
-- Remote ops synced from another device (`dag::insert_remote_op`) keep the
-- 'user' default. Cross-device origin propagation is not in FEAT-4h v2
-- scope; the sync protocol does not yet carry the `origin` field.
--
-- This is additive: the op-log hash-chain invariant is unaffected because
-- `origin` is not part of the hash preimage (see `hash::compute_op_hash`).
-- Mutating an existing row's `origin` would be a violation, but inserting
-- with the correct origin-for-the-caller is straight additive column use.

ALTER TABLE op_log
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
