# PEND-63 — Wire `not-state:` / `not-priority:` proper inversion

> Small backend fix. PEND-53 introduced `not-state:` and `not-priority:` tokens, but ships them as **visual-only chips** in v1 — the chips render but the IPC receives nothing, so the filter doesn't actually exclude anything. The autonomous review session flagged this as misleading. Wire the inversion properly: `state IS NULL OR state NOT IN (…)`.

## TL;DR

- **Backend.** ~S (~2-3 h). Add two fields to `SearchFilter`: `excluded_state_filter: Vec<String>`, `excluded_priority_filter: Vec<String>` (both `#[serde(default)]`). Compile to `(blocks.state IS NULL OR blocks.state NOT IN (…))` disjunctions in the SQL.
- **Frontend.** ~S (~1 h). Update `to-search-filter.ts` to project `not-state:` / `not-priority:` chips to the new excluded fields. Chip rendering unchanged (PEND-53 already renders them).
- **Tests.** Backend snapshot tests for the new SQL; cross-product (state + excluded-state); IPC error-path.
- **No new migrations.**

## Current state — verified

- `SearchFilter.state_filter: Vec<String>` and `priority_filter: Vec<String>` exist (PEND-53).
- `to-search-filter.ts` includes a comment block explaining that `not-state:` / `not-priority:` chips render but project nothing — the deliberate v1 limitation.
- `docs/SEARCH.md` documents the limitation; readers were promised a follow-up.
- `block_properties.state IS NULL` vs absence semantics: blocks without an explicit state have `blocks.todo_state` = NULL (verified). The inversion must include NULL by design — a "blocks NOT in the DONE state" query should return blocks with no state at all, not exclude them.

## Design

### Backend wire shape

```rust
// Appended to SearchFilter — same #[serde(default)] additive pattern.
pub struct SearchFilter {
    // … existing fields …
    pub excluded_state_filter: Vec<String>,       // PEND-63
    pub excluded_priority_filter: Vec<String>,    // PEND-63
}
```

### SQL composition

For `excluded_state_filter = ["DONE", "CANCELLED"]`:

```sql
AND (
  b.todo_state IS NULL
  OR b.todo_state NOT IN ('DONE', 'CANCELLED')
)
```

Same shape for `excluded_priority_filter`.

The `none` sentinel from PEND-53 (`not-state:none` would mean "exclude blocks with no state") routes to `b.todo_state IS NOT NULL`. Handled symmetrically to PEND-53's `state:none` → `IS NULL`.

### Frontend projection

`to-search-filter.ts` extends:

```ts
function projectFilters(ast: ParsedFilter[]): SearchFilter {
  // … existing logic …
  for (const tok of ast) {
    if (tok.kind === 'not-state') filter.excluded_state_filter.push(tok.value)
    if (tok.kind === 'not-priority') filter.excluded_priority_filter.push(tok.value)
  }
  // … rest unchanged …
}
```

Chip rendering unchanged — PEND-53 already renders the chips with the right label. The fix is purely making them functional.

### Edge cases (locked in)

- **`not-state:none`** → blocks WHERE `todo_state IS NOT NULL`. Excludes the no-state set.
- **`state:TODO` AND `not-state:DONE`** → state IS TODO AND (state IS NULL OR state ≠ DONE). The IS NULL branch is unreachable when state IS TODO, so this is effectively `state = TODO`. Documented as "redundant but valid".
- **`not-state:TODO` AND `not-state:DONE`** → state IS NULL OR state NOT IN (TODO, DONE). Same vocabulary as `state:DOING state:CANCELLED state:WAITING` plus NULL inclusion.
- **A literal custom state named `"none"`** → matches the NULL sentinel by design. Documented limitation (PEND-53 already calls this out).

## Phase split

### Phase 1 — Backend (S, ~1.5 h)

- Add the two fields to `SearchFilter` in `src-tauri/src/commands/queries.rs`.
- Implement the SQL composition in `src-tauri/src/fts/metadata_filter.rs::prepare_metadata`.
- Backend snapshot tests for the new SQL clauses.
- Cross-product tests: state + excluded-state (redundant case); state + priority + excluded-state.
- Specta bindings regen.

### Phase 2 — Frontend projection (S, ~0.5 h)

- Update `to-search-filter.ts` to populate the new fields.
- Update `lib/tauri.ts` wrapper if needed (additive; the bindings carry the new optional fields).
- Update the comment block in `to-search-filter.ts` to reflect "now wired".

### Phase 3 — Tests + docs (S, ~1 h)

- Frontend unit: `to-search-filter` projects `not-state:DONE` → `excluded_state_filter: ['DONE']`.
- Frontend integration: typing `not-state:DONE` returns fewer results than the unfiltered set.
- E2E: a fixture with a mix of DONE and TODO blocks; assert `not-state:DONE` excludes the DONE blocks.
- `docs/SEARCH.md`: update the limitation note to say "Wired in PEND-63 (date TBD)" or remove once landed.
- `AGENTS.md`: update the search-FTS pruning if needed (Phase 1 already documented the v1 limitation; once PEND-63 lands, the note moves to docs/architecture/search.md saying "wired with NULL-inclusive inversion").

## Tests

- Backend: 4 new SQL snapshot tests (excluded_state alone, excluded_priority alone, both together, with state combined).
- Frontend: `to-search-filter.test.ts` extends for the new projection.
- E2E: at least one fixture-based test confirming the chip + filter combination works end-to-end.

## Open questions

1. **`not-state:` with custom states** — works the same as `state:`; custom states the user has assigned freely compose. No additional design.
2. **MCP exposure** — the new excluded fields ride through the MCP search tool if PEND-65 (MCP filter exposure) lands. Otherwise: hard-coded as empty on the MCP side, consistent with how PEND-65 plans the MCP filter audit.

## Acceptance criteria

- `not-state:DONE` chip filters results to "blocks WHERE state IS NULL OR state ≠ DONE".
- `not-priority:` works symmetrically.
- The PEND-53 limitation note in `docs/SEARCH.md` is updated / removed.
- Test coverage: each new SQL clause has a snapshot test.
- Wire-compat additive: pre-PEND-63 frontends sending no `excluded_*_filter` fields still work.

## Related

- PEND-53 (landed) — introduced the v1 limitation this fixes.
- `pending/PEND-65-mcp-filter-exposure.md` — agent-side filter access.
- `src-tauri/src/fts/metadata_filter.rs` — SQL composition site.
- `src/lib/search-query/to-search-filter.ts` — AST projection site.
