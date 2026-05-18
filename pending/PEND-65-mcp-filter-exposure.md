# PEND-65 — MCP `search` tool: thread the full `SearchFilter` through to agents

> Small backend fix. PEND-54 hard-coded `include_page_globs: []` and `exclude_page_globs: []` when the MCP `search` tool dispatches into `search_blocks_inner`. PEND-53 followed the same pattern (every new filter field defaults to empty for MCP). So agents talking to Agaric can search by query string only — no path glob, no tag filter, no state / priority / date / property filters. Users have the full filter vocabulary; agents don't. The autonomous review session decided to fix this: thread the full filter set through the MCP tool surface.

## TL;DR

- **Backend (MCP).** ~M (~3-4 h). Extend the MCP `search` tool's argument schema to accept the same fields `SearchFilter` exposes (`tag_ids`, `parent_id`, `include_page_globs`, `exclude_page_globs`, `state_filter`, `priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters`, `case_sensitive`, `whole_word`, `is_regex`, `block_type_filter`). The tool handler maps the JSON args into `SearchFilter` and dispatches.
- **No frontend change.**
- **Inline filter syntax NOT exposed in MCP args.** The MCP arg schema takes structured fields, not a query string with embedded `tag:` / `state:` syntax — that's a user-facing UX. Agents already know the filter dimensions; let them pass structured arguments.
- **Specta bindings unchanged** — MCP tool schema is a separate surface from the Tauri command bindings.

## Current state — verified

- `src-tauri/src/mcp/tools_ro.rs::search` — the MCP search tool. Today it accepts `query` + optional cursor / limit / parent_id / tag_ids / space_id (verify exact fields). All new filter fields default to their zero values.
- The MCP tool schema is a JSON Schema declared in the tool handler; consumed by `rmcp` for input validation.
- Existing test: `src-tauri/src/mcp/tools_ro/tests.rs::tool_response_search` (snapshot test).

## Design

### MCP tool argument schema (extended)

```rust
// New schema additions (additive; existing fields preserved)
{
  "query": string,
  "cursor": optional<string>,
  "limit": optional<u32>,
  "filter": optional<{
    "parent_id": optional<BlockId>,
    "tag_ids": array<BlockId>,
    "space_id": optional<SpaceId>,
    "include_page_globs": array<string>,
    "exclude_page_globs": array<string>,
    "state_filter": array<string>,
    "priority_filter": array<string>,
    "excluded_state_filter": array<string>,    // adds in PEND-63
    "excluded_priority_filter": array<string>, // adds in PEND-63
    "due_filter": optional<{ "bucket": string } | { "op": "lt" | "lte" | ..., "value": ISO-date }>,
    "scheduled_filter": same shape as due_filter,
    "property_filters": array<{ "key": string, "value": optional<string> }>,
    "excluded_property_filters": same shape,
    "case_sensitive": bool,
    "whole_word": bool,
    "is_regex": bool,
    "block_type_filter": optional<string>
  }>
}
```

The schema is a thin wrapper over `SearchFilter`; the tool handler does a 1-1 map.

### Tool handler

```rust
async fn search(...) -> Result<Value, ServerError> {
    let filter = args.filter.unwrap_or_default();  // SearchFilter::default()
    let response = search_blocks_inner(
        pool,
        args.query,
        args.cursor,
        args.limit,
        filter,
    ).await?;
    Ok(serialize_response(response))
}
```

Verbatim pass-through. The current hard-coded `Vec::new()` for each filter field is replaced by the `args.filter` argument (or default if not provided).

### Backward compatibility for existing agents

Existing agents calling the MCP `search` tool without the new `filter` arg keep working — `filter` is optional and defaults to the zero `SearchFilter`. Same observable behaviour as today.

## Phase split

### Phase 1 — Schema + handler (S, ~1.5 h)

- Update the JSON Schema for the `search` tool in `src-tauri/src/mcp/tools_ro.rs`.
- Update the handler to take `filter: Option<SearchFilter>` and pass through.
- Backend snapshot test: existing `tool_response_search` snapshot stays green (no filter passed = same shape).
- New backend test: filter passed → results narrowed appropriately.

### Phase 2 — Documentation (S, ~1 h)

- `docs/architecture/mcp.md` (or wherever MCP tool surfaces are documented): list the new `filter` arg with each field's semantics.
- The MCP tool description (visible to agents on tool discovery) should list a few examples: `tag:`, `state:`, `due:` filtering.

### Phase 3 — Tests (S, ~1.5 h)

- For each filter dimension: a backend test that the MCP tool with that filter narrows results correctly.
- Round-trip test: agent passes structured `state_filter: ["TODO"]` → backend returns only TODO blocks → MCP response wraps them.

## Tests

- 7+ new MCP integration tests covering each filter dimension (tag, parent, path glob, state, priority, due bucket, due comparator, property, toggles).
- Existing `tool_response_search` snapshot stays green.

## Open questions

1. **Should agents pass `query` only and have the backend re-parse `tag:` / `state:` etc. from the query string?** No — agents are programmatic clients; structured args are clearer. Document the structured shape; users have the inline syntax separately.
2. **`is_regex: true` from agents** — fine; same caps + error path as user-facing.
3. **Limit caps** — already enforced in `search_blocks_inner` (`MAX_SEARCH_RESULTS = 100`). No new caps needed.

## Acceptance criteria

- MCP `search` tool with `filter: { state_filter: ["TODO"] }` returns only TODO blocks.
- MCP `search` tool without `filter` arg returns the same results as today (no regression).
- MCP `search` tool with `filter: { include_page_globs: ["Journal/*"] }` narrows to Journal pages.
- Test coverage: each filter dimension has at least one MCP integration test.
- `docs/architecture/mcp.md` lists the new `filter` arg shape.

## Related

- PEND-54 (landed) — introduced the hard-coded `[]` globs at the MCP boundary.
- PEND-53 (landed) — introduced the state / priority / prop filters not exposed via MCP.
- PEND-63 (planned) — adds excluded_state / excluded_priority fields the MCP schema also exposes.
- PEND-64 (planned) — `prop:` four-column matching; the MCP schema's `property_filters` field benefits automatically (no MCP change required for PEND-64).
- `src-tauri/src/mcp/tools_ro.rs` — `search` tool handler.
- `src-tauri/src/commands/queries.rs` — `SearchFilter` source of truth.
