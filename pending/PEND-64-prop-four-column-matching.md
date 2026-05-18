# PEND-64 — `prop:KEY=VALUE` matches all four typed columns

> Small backend fix. PEND-53's `prop:KEY=VALUE` token only matches `block_properties.value_text` in v1 — so `prop:priority=1` silently returns nothing because the value is stored in `value_num`. The autonomous review session decided to match **all four user-facing typed columns** automatically (`value_text` OR `value_num` OR `value_date` OR `value_ref`) with type coercion at SQL bind time. Backend does the type-guessing; the user never has to know which column their property lives in.

## TL;DR

- **Backend.** ~S (~2-3 h). Rewrite the `prop:` SQL composer in `src-tauri/src/fts/metadata_filter.rs` to emit a four-column OR clause with appropriate value coercion (parse the user's value string to text, number, date, ULID; bind each variant; let SQL match whichever column matches).
- **Frontend.** No change. The parser + chip already produce `SearchPropertyFilter { key, value }`; only the SQL backend behaviour changes.
- **No new migrations.**
- **Behaviour change is additive**: a property that was previously findable via `prop:` (text-typed) continues to match. Properties stored in other columns now also match.

## Current state — verified

- `block_properties` schema (migration `0062`): five typed value columns (`value_text`, `value_num`, `value_date`, `value_ref`, `value_bool`), mutually exclusive via CHECK constraint. Each row stores its value in exactly one column.
- v1 `prop:KEY=VALUE` SQL: `EXISTS (SELECT 1 FROM block_properties WHERE block_id = b.id AND key = ? AND value_text = ?)`. Only `value_text` is checked.
- `value_bool` is internal (not user-typed in UI); not in scope.
- Users with numeric properties (e.g. `:priority: 1` stored as a number) cannot find them via `prop:priority=1` today.

## Design

### SQL composition

For `prop:priority=1`, emit:

```sql
EXISTS (
  SELECT 1 FROM block_properties
  WHERE block_id = b.id
    AND key = ?1
    AND (
      value_text = ?2
      OR value_num = ?3                  -- bound only if ?2 parses as f64
      OR value_date = ?4                 -- bound only if ?2 parses as ISO date
      OR value_ref = UPPER(?2)           -- ULID match if ?2 is 26-char base32
    )
)
```

Or equivalently bind a parsed shape per variant:

```sql
EXISTS (
  SELECT 1 FROM block_properties bp
  WHERE bp.block_id = b.id
    AND bp.key = ?1
    AND (
      (bp.value_text IS NOT NULL AND bp.value_text = ?text)
      OR (bp.value_num IS NOT NULL AND bp.value_num = ?num)
      OR (bp.value_date IS NOT NULL AND bp.value_date = ?date)
      OR (bp.value_ref IS NOT NULL AND bp.value_ref = ?ref)
    )
)
```

The bind-shape variant is preferred — clearer plan + no implicit casts. Build the bindings via a small `parse_prop_value` helper:

```rust
struct PropMatchBinds<'a> {
    text: &'a str,
    num: Option<f64>,        // None if value doesn't parse as f64
    date: Option<NaiveDate>, // None if value doesn't parse as ISO date
    ref_: Option<String>,    // Some(uppercase) if value is 26-char base32 ULID
}

fn parse_prop_value(raw: &str) -> PropMatchBinds<'_> { /* … */ }
```

When a variant fails to parse, bind it as `NULL` and the `IS NOT NULL AND = ?` clause skips it. No accidental match.

### Edge cases (locked in)

- **Property with both numeric and text values across blocks** (rare; the CHECK enforces one column per row but different rows can use different columns for the same key) — the OR clause matches whichever column carries the value. Acceptable.
- **`prop:KEY=`** (empty value) — preserves the PEND-53 behaviour: matches "block has this key at all" via `bp.key = ?` only, no value clause.
- **`prop:KEY=2026-05-17`** — value parses as both text ("2026-05-17") and date (NaiveDate). Both bind variants populate; SQL OR resolves to a match on whichever column the property actually uses. Correct.
- **`prop:priority=A`** — value parses as text only ("A"); num / date / ref variants are NULL. SQL matches `value_text = 'A'`. Same as v1.
- **`prop:author=01HKQ2RWWWGM34RTGFE9XCRYZ4`** (ULID) — value parses as text AND as ref_ (uppercase ULID); both bound; SQL matches on whichever column holds the page link.
- **Case sensitivity**: `value_text` matching stays case-sensitive (matches v1). `value_ref` is normalised to uppercase per ULID convention.

### Property type discoverability

The autocomplete popover (PEND-60) surfaces known property keys but doesn't show their types. Users won't see "this is a numeric property" — they just type the value and the SQL matches whichever column holds it. Net effect: it Just Works.

## Phase split

### Phase 1 — Backend SQL + binding (S, ~1.5 h)

- New `parse_prop_value(raw: &str) -> PropMatchBinds` in `fts/metadata_filter.rs`.
- Update `compose_property_filter_sql` (or equivalent helper) to emit the four-column OR clause.
- Backend snapshot tests for each variant: pure text, pure number, ISO date, ULID, mixed (parses as both text+date), empty.
- `EXPLAIN QUERY PLAN` test confirming the new clause still uses `idx_block_props_key_text` / `idx_block_properties_key_value_num` / `idx_block_props_key_value_date` / `idx_block_props_key_value_ref` (verify each index name in migration history).

### Phase 2 — Tests + docs (S, ~1 h)

- Fixture: 4 blocks, each with the same property key but different typed values (text, num, date, ref). Assert each `prop:key=VALUE` query matches exactly the corresponding block.
- `docs/SEARCH.md`: update the PEND-53 limitation note ("v1 matches `value_text` only") to "matches all four user-facing columns automatically".
- `AGENTS.md`: update the search-FTS invariant if it still says "value_text only" (post-pruning, this should already be moved to `docs/architecture/search.md`).

## Tests

- Backend: 6 snapshot tests covering each variant + the empty-value case + a mixed-parse case.
- Backend: index-usage assertion (`EXPLAIN QUERY PLAN` includes the right index name for each bound variant).
- Backend: fixture-based correctness test (4 blocks, 4 query variants, exact match).
- Frontend: no change — `to-search-filter` already produces `SearchPropertyFilter { key, value }`; SQL backend handles the rest.

## Open questions

1. **Performance** — four indexed sub-clauses per `prop:` token. Acceptable for the typical 1-3 chip query. **Target to measure** at 10K blocks × 5 properties = 50K rows. If the plan loses index usage at scale, revisit by splitting into one EXISTS per column (rare anti-pattern, but tractable).
2. **Type coercion ambiguity** — `prop:date=2026` parses as both number (year) and text. The OR clause matches both; correct as long as no property simultaneously has `value_num=2026` AND `value_text="2026"` for different blocks. Edge-case; accepted.
3. **Should we expose `propnum:` / `propdate:` / `propref:` tokens** for users who want to force a single-column match? Defer — automatic matching covers the common case; explicit tokens add cognitive load.

## Acceptance criteria

- `prop:priority=1` returns blocks where `value_num = 1` (was empty in v1).
- `prop:due-date=2026-05-17` returns blocks where `value_date = '2026-05-17'` (was empty in v1).
- `prop:author=01HKQ2RWWWGM34RTGFE9XCRYZ4` returns blocks where `value_ref = '01HKQ...'`.
- `prop:status=draft` (text) still matches the same blocks as v1 (no regression).
- `EXPLAIN QUERY PLAN` shows index usage on each typed column.
- `docs/SEARCH.md` updated; `block_properties` four-column mention is current.

## Related

- PEND-53 (landed) — introduced the v1 `value_text`-only limitation this fixes.
- `pending/PEND-65-mcp-filter-exposure.md` — agent-side; consumes the same backend logic.
- `src-tauri/src/fts/metadata_filter.rs` — SQL composition site.
- `src-tauri/migrations/0062_*.sql` — `block_properties` CHECK constraint definition.
