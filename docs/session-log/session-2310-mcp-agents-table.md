# Session 2310 — A device-local table of MCP agents, with list, create and revoke

Step 2 of #5667's approved design (agent tokens: per-agent read-only or
read-write mode and allowed spaces, managed in Settings). Nothing in the MCP
connection path reads the table yet; step 4, the one-socket cut that
requires a token, is held for the maintainer.

**Migration 0125.** `mcp_agents`, STRICT, exactly as approved:
- `name` is unique and `COLLATE NOCASE`;
- `mode` is `read_only` or `read_write`;
- `space_ids` is a JSON array, or NULL for all spaces;
- `token` is a unique plain-text `agt_` value;
- `created_at_ms` and `last_used_ms` are checked non-negative.

Rows stay on the device and no op type exists for them, because a token only
works against this machine's socket.

**Commands** (thin wrapper plus `*_inner`):
- `list_mcp_agents` on the reader pool;
- `create_mcp_agent` validates and inserts:
  - the name is trimmed, with no control characters, and capped in chars,
    not bytes;
  - a case-variant duplicate is refused by one atomic
    `INSERT … ON CONFLICT(name) DO NOTHING`;
  - an empty space list, or one naming a space that is not live (one
    `json_each` query), is refused;
- `revoke_mcp_agent` deletes the row and answers `NotFound` for an unknown
  id.

`MAX_AGENT_NAME_LEN` moved beside the queries. Three new validation codes let
Settings say which input was refused; only `DuplicateAgentName` has a
consumer before step 3.

**Mock.** It mirrors the commands' checks and ordering. Conformance is waived
as open debt, because each stack mints its own ids and tokens, so pinning
needs a name-keyed projection.

**Review.** The migration test did not pin `token UNIQUE` or the two `_ms`
checks; dropping any stayed green, and step 4's token lookup relies on the
uniqueness. Three single-fault rows now pin them. The migration also applied
cleanly to a copy of `dev.db` rewound to 0124. `COLLATE NOCASE` folds ASCII
only, so "É" and "é" can both be names; that is left as is.

**Tests.** Eleven mutants were each killed at the predicted assertion: NOCASE,
STRICT, the mode check, the json check, token UNIQUE, both `_ms` checks,
chars against bytes, the dead-space check, the empty-list check, and revoke.

Gates: the full workspace suite (3498 + 3491, builder), the migration tests
(42), clippy, `SQLX_OFFLINE=true cargo check`, fmt, vitest on the mock and
validation codes (1,444), and `npm run typecheck`.
