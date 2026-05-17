# PEND-53 — Property / metadata filters in the find-in-files view

> Extends PEND-54's inline-filter-syntax framework with structured filters for the typed metadata Agaric already stores (todo_state, priority, due_date, scheduled_date) and for free-form `block_properties`. All filters use the framework — typeable in the input, mirrored as chips, discoverable through the `+ Filter ▾` popover with autocomplete. The framework is owned by PEND-54; this plan only registers new token recognisers and adds the SQL.
>
> **Reuses existing infrastructure**: `BacklinkFilterBuilder.tsx` (258 LOC) and `AgendaFilterBuilder.tsx` (419 LOC) already handle structured filters over property/state/priority/date — date-range vocabulary, priority-level resolution, property-key autocomplete cache. This plan inherits their building blocks (`usePropertyKeysCache`, `usePriorityLevels`, `backlink.*` i18n keys) rather than authoring parallel infrastructure.
>
> **Not in the palette (PEND-51).** Property filters are a find-in-files concern; the palette stays minimal.

## Why this plan exists

`BlockRow` carries `todo_state`, `priority`, `due_date`, `scheduled_date` columns; the `block_properties` table stores arbitrary key-value metadata. The backend already exposes `queryByProperty` / `queryByTags` IPCs that lift these values into search. The `SearchPanel` does not surface any of this. For an Org-mode-inspired app where users care about "all `TODO` blocks with `priority:1` due this week in `Journal/2026-*`", the omission is a real gap.

## What this plan adds

| Inline token | Meaning | SearchFilter field |
|---|---|---|
| `state:TODO` | Block's `todo_state = 'TODO'`. Repeating ORs (`state:TODO state:DOING` = state IN (TODO, DOING)). | `state_filter: Vec<String>` |
| `priority:1` | Block's `priority = '1'`. Repeating ORs. | `priority_filter: Vec<String>` |
| `due:overdue` `due:today` `due:this-week` `due:<2026-06-01` `due:>=2026-01-01` `due:none` | Block's `due_date` matches the predicate. | `due_filter: Option<DateFilter>` |
| `scheduled:…` | Same predicate vocabulary as `due:`, applied to `scheduled_date`. | `scheduled_filter: Option<DateFilter>` |
| `prop:key=value` | Block has a property where `key='key' AND value_text='value'`. Repeating ANDs. v1 matches **`value_text` only** (free-form string values). | `property_filters: Vec<(String, String)>` |
| `not-prop:key=value` | Block does NOT have that property/value. v1 matches `value_text` only. | `excluded_property_filters: Vec<(String, String)>` |

The `DateFilter` shape resolves named ranges (`overdue`, `today`, `this-week`, `next-week`, `this-month`, `none`) against the current date in Rust at query time, and accepts explicit comparison operators (`<`, `<=`, `=`, `>=`, `>`) followed by an ISO date.

## Inheritance from PEND-54 + existing infrastructure

**PEND-54 lands the framework** this plan extends:

- The parser (`src/lib/search-query/tokenize.ts` + `classify.ts`) — extensible via `registerTokenPrefix(...)`.
- The serialiser — round-trips any registered token.
- The chip-row UI + autocomplete popover — generic over token kind.
- The `+ Filter ▾` discovery menu — accepts new entries.
- AST → IPC projection — extended to project new tokens into new `SearchFilter` fields.
- The help dialog's *Filter syntax* section — table grows with new rows.

**Existing Agaric infrastructure this plan reuses (does NOT author parallel)**:

- `src/components/BacklinkFilterBuilder.tsx` (258 LOC) — date-range vocabulary, property-key picker, state/priority controls. Lift the date-range named ranges (`backlink.dateAfterLabel`, etc.) into a shared module so PEND-53 and BacklinkFilterBuilder use identical strings.
- `src/components/AgendaFilterBuilder.tsx` (419 LOC) — `state:` / `priority:` / `due:` semantics already canonical in agenda view; reuse the same predicate vocabulary so both surfaces agree.
- `src/hooks/usePropertyKeysCache.ts` (existing, ~2.7 KB) — invalidated on materializer dirty events. Autocomplete for `prop:` token uses this directly.
- `src/lib/property-keys-cache.ts` (~6 KB) — the data layer behind the hook.
- `src/hooks/usePriorityLevels.ts` (~823 B) — canonical priority enumeration. Autocomplete for `priority:` uses this.
- i18n: reuse `backlink.statusOption`, `backlink.priorityOption`, `backlink.propertyOption`, `backlink.dateAfterLabel`, etc. (lines 94-163 of `src/lib/i18n/references.ts`) where semantics match. New keys only for tokens that don't exist in BacklinkFilterBuilder's vocabulary.

PEND-54's parser-registry contract must be design-tested in PEND-54's own tests by registering a stub token — to prevent PEND-53 from being blocked by a not-actually-open registry.

## Design

### UX

The chip row + `+ Filter ▾` popover from PEND-50 grows new entries. No new layout; the chips just include the new types.

```text
┌──────────────────────────────────────────────────────────────┐
│  [TODO state:DOING priority:1 due:this-week] [Aa Ab| .*] ? │
│  [state:DOING ×] [priority:1 ×] [due:this-week ×]  + Filter ▾│
└──────────────────────────────────────────────────────────────┘
```

Autocomplete behaviour per token:

- `state:` → popover lists known states from `todo_state` column distinct values + the documented set (`TODO`, `DOING`, `DONE`, `WAIT`, `CANCELLED`). Multi-select via repeated tokens.
- `priority:` → popover lists `1`, `2`, `3`, `none`.
- `due:` / `scheduled:` → popover lists named ranges first (`overdue`, `today`, `this-week`, `this-month`, `none`), then a free-form ISO-date input with a `< <= = >= >` selector. Date input uses the existing date-picker primitive.
- `prop:` → popover lists distinct property keys from the `block_properties` table (cached on first open). After `prop:key=`, popover lists distinct values for that key.

### Backend

Three new SearchFilter fields and one new typed-error variant:

```rust
pub struct SearchFilter {
    // …existing fields from PEND-50…

    // PEND-53 additions (#[serde(default)] — backward compatible)
    pub state_filter: Vec<String>,
    pub priority_filter: Vec<String>,
    pub due_filter: Option<DateFilter>,
    pub scheduled_filter: Option<DateFilter>,
    pub property_filters: Vec<PropertyFilter>,         // (key, value) AND-joined
    pub excluded_property_filters: Vec<PropertyFilter>,
}

#[derive(Deserialize, Serialize, specta::Type)]
pub enum DateFilter {
    Named(NamedRange),                       // Overdue, Today, ThisWeek, ThisMonth, NextWeek, None
    Op { op: DateOp, date: chrono::NaiveDate },  // <, <=, =, >=, >
}

pub enum SearchFilterError {
    // …existing…
    InvalidDateFilter(String),  // unparseable date or named range
}
```

SQL extensions to the existing query (in addition to PEND-50's GLOB sub-select):

```sql
-- state / priority — emit only when the filter is non-empty
-- Existing indexes idx_blocks_todo (todo_state) and idx_blocks_due / idx_blocks_scheduled
-- (migrations 0012, 0013) accelerate these clauses; no new indexes required.
AND (?state_count = 0 OR b.todo_state IN (?, ?, …))
AND (?priority_count = 0 OR b.priority IN (?, ?, …))

-- due / scheduled — emit only when the filter is set
AND (?due_filter_kind = 'none' OR b.due_date <comparison> ?due_value)
AND (?scheduled_filter_kind = 'none' OR b.scheduled_date <comparison> ?scheduled_value)

-- property includes / excludes — sub-select against block_properties
-- CRITICAL: value_text (free-form strings), NOT value_ref (which is a FK to blocks(id) for
-- reference-typed properties like 'space'). The five typed value columns (value_text,
-- value_num, value_date, value_ref, value_bool) are mutually exclusive per the CHECK in
-- migration 0062. v1 matches only value_text (the most common case for user-typed properties).
AND (?prop_inc_count = 0 OR b.id IN (
  SELECT bp.block_id FROM block_properties bp
  WHERE (bp.key = ?k1 AND bp.value_text = ?v1)
     OR (bp.key = ?k2 AND bp.value_text = ?v2) OR …
))
AND (?prop_exc_count = 0 OR b.id NOT IN (
  SELECT bp.block_id FROM block_properties bp
  WHERE (bp.key = ?k1 AND bp.value_text = ?v1) OR …
))
```

The `(key, value_text)` index `idx_block_props_key_text` (migration 0004:4, partial WHERE value_text IS NOT NULL) covers the sub-select directly.

Named ranges resolve to literal date comparisons in Rust before binding:

- `overdue` → `due_date < today`
- `today` → `due_date = today`
- `this-week` → `due_date BETWEEN start_of_week AND end_of_week`
- `none` → `due_date IS NULL`

(Boundaries respect locale-week-start; reuses whichever convention the existing agenda views use.)

### Edge cases

- **`prop:key=` with no value.** Treat as "block has this key at all". Implementation: omit the `value_ref` clause in that token's sub-select.
- **`prop:key=*`.** Same as the above; documented in help.
- **Date filter with invalid date** (e.g. `due:2026-13-99`). Typed error `InvalidDateFilter`; inline red chip with the error text.
- **State value not in the documented set** (e.g. `state:CUSTOM`). Allowed — `todo_state` is a free-form string column; user might have a custom state. No validation.
- **`priority:none`.** Matches `priority IS NULL`. Documented in help.

## Phase split

### Phase 1 — Typed columns (M, ~8-12 h)

- Backend: extend `SearchFilter` with `state_filter`, `priority_filter`, `due_filter`, `scheduled_filter` + the typed-error variant.
- Parser: register `state:`, `priority:`, `due:`, `scheduled:` token recognisers + the `DateFilter` parser.
- UI: extend `FilterHelperPopover` with the four new entries; extend autocomplete to surface known states / priority values / named date ranges.
- Help dialog: extend "Filter syntax" table.
- Tests: parse + serialise round-trip for each token; SQL emits correctly per filter combination; date-range edge cases (year boundary, week start, none-vs-null); typed errors render inline.

### Phase 2 — `block_properties` filters (M, ~6-10 h)

- Backend: extend `SearchFilter` with `property_filters` + `excluded_property_filters` + the property sub-select SQL.
- Parser: register `prop:` and `not-prop:` recognisers.
- UI: add `+ Property…` entry to the helper popover; two-step autocomplete (key, then value).
- Property key/value caching: small Zustand store, invalidated on materializer-commit events (reuse existing dirty-events infrastructure).
- Tests: prop AND across multiple keys; not-prop excludes; missing-value semantics (`prop:status=` = "has the key"); cache invalidation on edit.

## Cost / Impact / Risk

- **Cost:** Phase 1 ~8-12 h. Phase 2 ~6-10 h. **Total M (~14-22 h, ~2-3 days).**
- **Impact:** **High for the Org-mode aspirant user.** Closes the largest single feature gap vs Obsidian's property search and Logseq's `query` blocks. Makes the find-in-files view a true workflow tool, not just a text search.
- **Risk:** **Low-Medium.** Backend SQL is mechanical (sub-selects, IN-lists, date comparisons). Frontend reuses PEND-50's framework — the only new UX is per-token autocomplete population, and that follows the `SearchablePopover` pattern Agaric already has.

## Locked-in decisions (formerly open questions)

1. **Property key case-sensitivity: case-sensitive.** Verified: `block_properties.PRIMARY KEY (block_id, key)` has no `COLLATE NOCASE`. `Foo` and `foo` are distinct keys. Autocomplete shows keys verbatim. Document in `docs/SEARCH.md`.
2. **`state:` for non-todo blocks: explicit-only.** A block with `todo_state IS NULL` is matched only by `state:none` (an explicit token); `state:TODO` only matches blocks with that literal state. No implicit null inclusion. Same shape for `priority:none`.
3. **`scheduled:` semantics for repeating tasks: out-of-scope for v1.** Repeating-task `next_repeat` resolution is in the agenda projection; threading it through search would duplicate that logic across two surfaces. v1 matches `b.scheduled_date` literally. Document explicitly: "repeating tasks are matched only when their literal scheduled_date column falls in range; the next dynamically-computed occurrence is not surfaced." File a REVIEW-LATER tombstone if/when this becomes a real complaint.
4. **Property value type coercion: v1 matches `value_text` only.** `block_properties` has 5 mutually-exclusive value columns (per migration 0062 CHECK). v1 documents that `prop:status=done` matches `value_text='done'`; numeric/date/reference values are not searchable in v1. Users wanting to filter by a numeric property must store it as text. Document the workaround in `docs/SEARCH.md`'s "Property filter limitations" section.

## Related

- `pending/PEND-50-search-vscode-ux.md` — the framework this plan extends; the parser / serialiser / chip UI / helper popover all live there.
- `src/components/AgendaView/` — the existing surface where `todo_state` / `priority` / dates are filterable today; consider unifying the date-range vocabulary across both.
- `src-tauri/src/commands/queries.rs` — site for the SQL extensions; reuses the same `QueryBuilder` pattern as PEND-50.
- `src-tauri/src/commands/properties.rs` (or equivalent) — existing `queryByProperty` infrastructure to reference, not necessarily reuse directly.
- `pending/IDEAS.md` — saved-searches and search-and-replace are filed there.
