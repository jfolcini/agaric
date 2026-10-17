-- #5667 — the MCP agents Settings → Agent access manages: each has a name
-- (its writes are attributed to `agent:<name>`), a mode, the spaces it may
-- use and the token its `agaric-mcp` bridge presents.
--
-- Device-local, like `page_opens` and `peer_refs`: no op type, no Loro state,
-- so nothing syncs or exports it. A token only works against this device's
-- socket.
--
-- `space_ids` is a JSON array of space ids, read whole and never queried by
-- space; NULL means every space, including spaces created later. No foreign
-- key: a `blocks` rebuild runs `DELETE FROM spaces`, which would cascade into
-- a child table, and an id whose space was deleted matches nothing, so the
-- agent loses that space rather than gaining one.
--
-- The token is plain text (`agt_` and 32 hex digits) so Settings can show the
-- client config again; anyone who can read this file can read every note.
-- Revoking deletes the row.
CREATE TABLE mcp_agents (
    id            TEXT PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    mode          TEXT NOT NULL CHECK (mode IN ('read_only', 'read_write')),
    space_ids     TEXT CHECK (space_ids IS NULL OR json_type(space_ids) = 'array'),
    token         TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    -- NULL until the agent's first tool call.
    last_used_ms  INTEGER CHECK (last_used_ms IS NULL OR last_used_ms >= 0)
) STRICT;
