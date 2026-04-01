# Backlinks Filter Plan — Server-Side Query Expression System

> Composable filter expressions for backlinks, inspired by Org-mode agenda filters and Logseq simple queries.

## Current State

**BacklinksPanel today** has 4 hardcoded client-side `<select>` filters:
- **Type** — `content | page | tag`
- **Status** — `TODO | DOING | DONE | none` (fetched via N `getProperties()` calls)
- **Date** — `today | week | month` (derived from ULID timestamp = creation date only)
- **Priority** — `A | B | C | none` (also via `getProperties()`)

**Problems:**
1. Filters only apply to **already-loaded** pages — incomplete results
2. N+1 IPC calls — one `getProperties()` per block
3. Hardcoded filter values — can't filter by arbitrary properties
4. Date filter is creation date only — no `due-date` or `scheduled` properties
5. No date ranges, no sort control, no text search within backlinks
6. No compound queries — can't express `(TODO OR DOING) AND priority=A`
7. No saved filters / presets

**Backend already supports (underutilized):**
- `get_batch_properties(blockIds[])` — batch property fetch
- `query_by_property(key, valueText)` — single key+value filter
- `tag_query.rs` — full boolean expression tree (And/Or/Not/Tag/Prefix)
- `search_fts(query)` — full-text search
- `block_properties` typed columns: `value_text`, `value_num`, `value_date`, `value_ref`

---

## Phase A — Backend: `query_backlinks_filtered` (Rust)

New Tauri command that pushes filtering to SQL. Foundation for everything else.

### A1. BacklinkFilter enum + types

New file: `src-tauri/src/backlink_query.rs`

```rust
use serde::Deserialize;

/// Comparison operators for property filters.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum CompareOp {
    Eq,      // =
    Neq,     // !=
    Lt,      // <
    Gt,      // >
    Lte,     // <=
    Gte,     // >=
}

/// Composable filter for backlinks queries.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkFilter {
    /// Property key compared against text value.
    PropertyText { key: String, op: CompareOp, value: String },
    /// Property key compared against numeric value.
    PropertyNum { key: String, op: CompareOp, value: f64 },
    /// Property key compared against date value (ISO 8601 string).
    PropertyDate { key: String, op: CompareOp, value: String },
    /// Property key is set (has any value).
    PropertyIsSet { key: String },
    /// Property key is empty (not set).
    PropertyIsEmpty { key: String },
    /// Block has the given tag.
    HasTag { tag_id: String },
    /// Block has any tag matching the prefix.
    HasTagPrefix { prefix: String },
    /// Block content matches FTS5 query.
    Contains { query: String },
    /// Block created within date range (ULID timestamp).
    CreatedInRange { after: Option<String>, before: Option<String> },
    /// Block type filter.
    BlockType { block_type: String },
    /// All sub-filters must match.
    And { filters: Vec<BacklinkFilter> },
    /// Any sub-filter may match.
    Or { filters: Vec<BacklinkFilter> },
    /// Negate a filter.
    Not { filter: Box<BacklinkFilter> },
}

/// Sort direction for backlink results.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum SortDir { Asc, Desc }

/// Sort specification for backlink queries.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum BacklinkSort {
    /// Sort by creation time (ULID order). Default.
    Created { dir: SortDir },
    /// Sort by a property's text value.
    PropertyText { key: String, dir: SortDir },
    /// Sort by a property's numeric value.
    PropertyNum { key: String, dir: SortDir },
    /// Sort by a property's date value.
    PropertyDate { key: String, dir: SortDir },
}
```

### A2. eval_backlink_filter() resolver

Same pattern as `tag_query.rs`:
1. Get base backlink set: `SELECT source_id FROM block_links WHERE target_id = ?`
2. Resolve filter tree into `FxHashSet<block_id>` (same in-memory set-operation pattern)
3. Intersect backlink set with filter set
4. Apply sort + keyset cursor pagination
5. Return `PageResponse<BlockRow>` with `total_count`

**Response type:**
```rust
#[derive(Serialize, specta::Type)]
pub struct BacklinkQueryResponse {
    pub items: Vec<BlockRow>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_count: usize,
}
```

**Filter evaluation (leaf nodes):**

| Filter variant | Resolution |
|---|---|
| `PropertyText` | `SELECT block_id FROM block_properties WHERE key = ? AND value_text op ?` |
| `PropertyNum` | `SELECT block_id FROM block_properties WHERE key = ? AND value_num op ?` |
| `PropertyDate` | `SELECT block_id FROM block_properties WHERE key = ? AND value_date op ?` |
| `PropertyIsSet` | `SELECT block_id FROM block_properties WHERE key = ?` |
| `PropertyIsEmpty` | Complement: all blocks minus `PropertyIsSet` |
| `HasTag` | Delegate to `tag_query::resolve_expr(Tag(id))` |
| `HasTagPrefix` | Delegate to `tag_query::resolve_expr(Prefix(prefix))` |
| `Contains` | `SELECT rowid FROM fts_blocks WHERE fts_blocks MATCH ?` |
| `CreatedInRange` | ULID timestamp extraction in Rust, filter in-memory |
| `BlockType` | `SELECT id FROM blocks WHERE block_type = ?` |
| `And` | Intersection of all sub-filters |
| `Or` | Union of all sub-filters |
| `Not` | Complement (all backlinks minus inner set) |

### A3. query_backlinks_filtered Tauri command

```rust
#[tauri::command]
#[specta::specta]
pub async fn query_backlinks_filtered(
    pool: tauri::State<'_, ReadPool>,
    block_id: String,
    filters: Option<Vec<BacklinkFilter>>,
    sort: Option<BacklinkSort>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<BacklinkQueryResponse, AppError> { ... }
```

When `filters` is `None` or empty, behaves like current `get_backlinks` (no regression).

### A4. Migration: property indexes

New migration `0004_backlink_query_indexes.sql`:
```sql
-- Index for property key lookups (covers PropertyText, PropertyIsSet filters)
CREATE INDEX IF NOT EXISTS idx_block_props_key
    ON block_properties(key, block_id);

-- Index for property key+text lookups
CREATE INDEX IF NOT EXISTS idx_block_props_key_text
    ON block_properties(key, value_text)
    WHERE value_text IS NOT NULL;

-- Index for property key+num lookups
CREATE INDEX IF NOT EXISTS idx_block_props_key_num
    ON block_properties(key, value_num)
    WHERE value_num IS NOT NULL;
```

### A5. Backend tests (~40-60 tests)

Inline `#[cfg(test)] mod tests` in `backlink_query.rs`:
- Each filter variant: happy path + edge cases
- Compound filters: And, Or, Not combinations
- Sort variants: created, property text/num/date, asc/desc
- Pagination: cursor, limit, total_count
- Empty filter (backward compat with plain backlinks)
- Error cases: empty block_id, invalid FTS query

### A6. sqlx prepare + specta bindings

After all SQL changes:
```bash
cd src-tauri && cargo sqlx prepare -- --lib
cd src-tauri && cargo test -- specta_tests --ignored
```

Update `src/lib/tauri.ts` with wrapper for `query_backlinks_filtered`.

---

## Phase B — Frontend: Filter Builder + Panel Rewrite

### B1. BacklinkFilterBuilder component

Visual filter builder using pill/chip UI:
- "Add filter" button → dropdown: Property, Tag, Status, Priority, Date, Content
- Each filter renders as a removable pill: `[todo = TODO ×]`
- AND/OR toggle between filter pills
- Autocomplete for property keys (via new `list_property_keys` command)
- Autocomplete for tag names (existing `list_tags_by_prefix`)

### B2. list_property_keys Tauri command

```rust
pub async fn list_property_keys_inner(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    // SELECT DISTINCT key FROM block_properties ORDER BY key
}
```

Used for property key autocomplete in the filter builder.

### B3. Sort controls

Dropdown or button group:
- Created (default) ↑↓
- Property value ↑↓ (with key selector)
- Alphabetical ↑↓

### B4. Saved presets (localStorage)

```typescript
interface FilterPreset {
  name: string
  filters: BacklinkFilter[]
  sort?: BacklinkSort
}
```

Stored in `localStorage` under `blocknotes:backlink-presets`. Quick-apply buttons in toolbar.

### B5. BacklinksPanel rewrite

Replace current implementation:
- Remove client-side filter state (typeFilter, statusFilter, dateFilter, priorityFilter)
- Remove N+1 `getProperties()` calls
- Remove ULID timestamp decoder
- Use `queryBacklinksFiltered()` for all queries
- Integrate `BacklinkFilterBuilder` for filter construction
- Show `total_count` in panel header: "Backlinks (12)"
- Preserve: resolve cache, rich content rendering, load more

### B6. Frontend tests (~30-40 tests)

- BacklinkFilterBuilder: render, add/remove filters, AND/OR toggle, clear all
- Sort control: render, selection changes
- BacklinksPanel: integration with new API, filter + sort, total count display
- Preset: save/load from localStorage
- a11y: axe audit on filter builder and panel
- Error states: API failure, empty results

---

## Phase C — Power Features (Future)

### C1. Date-relative expressions
Parse: `today`, `tomorrow`, `+3d`, `-1w`, `this-week`, `this-month`. Resolve client-side to ISO dates.

### C2. Content search within backlinks
Search input in filter bar → `Contains` filter clause.

### C3. Keyboard shortcut presets
`t` → TODO, `d` → Due today, `w` → Due this week, `h` → High priority, `/` → Search.

### C4. Result count badge
"Backlinks (12)" on the tab. Uses `total_count` from response.

### C5. Group-by mode
Group by property value, parent page, or tag. Client-side grouping.

---

## Task Dependencies

```
Phase A (Rust backend) ─── no frontend dependency
  A1. BacklinkFilter enum + types
  A2. eval_backlink_filter() resolver
  A3. query_backlinks_filtered Tauri command
  A4. Migration: property indexes
  A5. Backend tests (~40-60 tests)
  A6. sqlx prepare + specta bindings

Phase B (Frontend) ─── depends on A6
  B1. BacklinkFilterBuilder component
  B2. list_property_keys command + autocomplete
  B3. Sort controls
  B4. Saved presets (localStorage)
  B5. BacklinksPanel rewrite
  B6. Frontend tests (~30-40 tests)

Phase C (Power features) ─── depends on B5
  C1-C5 (incremental, per-feature)
```

## Comparison: Org-mode / Logseq / This Plan

| Capability | Org-mode | Logseq | This plan |
|---|---|---|---|
| TODO state filter | `/ t` | `(task TODO)` | `todo = "TODO"` |
| Priority filter | `/ p [#A]` | `(priority A)` | `priority = "A"` |
| Date range | `DEADLINE<+7d` | `(between -7d today)` | `due-date between today +7d` |
| Arbitrary property | Column view | `(property key val)` | `key op value` (typed) |
| Tag boolean | `+work-personal` | `(and [[work]] (not [[personal]]))` | `HasTag + Not` |
| Text search | `/ /regex/` | Datalog | `Contains "meeting"` |
| Compound queries | Custom commands | `(and ...)` | `And/Or/Not` tree |
| Numeric comparison | No | No | `effort > 3` |
| Saved presets | Custom commands | No | localStorage + shortcuts |
| Sort by property | Column view | `:sort-by` | `BacklinkSort` enum |
| Inline queries | Embedded agenda | `{{query ...}}` | Phase 5 candidate |
