# PEND-14 — Native `boolean` value type for the property system

## Problem

The property system supports 5 typed value columns: `text`, `number`, `date`, `select`, `ref` (migrations 0011 + 0019). Booleans are modeled as `select` with single option `['true']`, where absence = false. Canonical example: `is_space` (migration 0035 + retype in 0039).

```sql
-- 0035_spaces.sql
INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES
    ('is_space', 'text', NULL, '2026-04-23T00:00:00Z');

-- 0039_is_space_select_type.sql
UPDATE property_definitions
SET value_type = 'select', options = '["true"]'
WHERE key = 'is_space';
```

Funky but functional. The select dropdown with one option is a poor UX surface for a binary toggle, and the "absence = false" convention is unwritten.

Other boolean-shaped properties found in the codebase (used in agenda / projected-agenda cache logic but not yet defined as property_definitions rows):

- `template` (filters template blocks from agenda views)
- `archived` (filters archived blocks)
- `pinned` (not yet implemented; natural future candidate)

## Schema design

**Option A — new `value_bool` column on `block_properties` (RECOMMENDED).** Symmetric with `value_text`, `value_num`, `value_date`, `value_ref`. SQLite stores as `INTEGER`, with CHECK constraint to (0, 1, NULL). Pros: orthogonal, type-safe at schema level, indexable. Cons: one more column (negligible).

**Option B — store booleans in `value_num`** with a value-type marker. No schema migration. Pros: less change. Cons: type confusion (number vs boolean both store in `value_num`); harder to query/validate.

**Decision: Option A.** Symmetry + clarity beat saving one column.

## Migrations

(Verify next migration number first — current max is `0041_gcal_space_config.sql` so next is `0042_*`.)

### 0042_add_value_bool_column.sql

```sql
-- SQLite 3.37+ required for ALTER TABLE ... ADD COLUMN ... CHECK syntax.
-- (The repo's pinned sqlx 0.8.6 bundles SQLite well above this version,
-- but the minimum-SQLite-version invariant should be documented in BUILD.md
-- as a follow-up — reviewer note.)
ALTER TABLE block_properties ADD COLUMN value_bool INTEGER
  CHECK (value_bool IS NULL OR value_bool IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_block_properties_value_bool
  ON block_properties(value_bool)
  WHERE value_bool IS NOT NULL;
```

### 0043_property_definitions_allow_boolean.sql

The `property_definitions.value_type` column has a CHECK constraint (originally migrations 0011 + 0019) restricting values to `('text', 'number', 'date', 'select', 'ref')`. SQLite cannot ALTER constraints in place; must recreate the table:

```sql
CREATE TABLE property_definitions_new (
    key TEXT PRIMARY KEY NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'select', 'ref', 'boolean')),
    options TEXT,
    created_at TEXT NOT NULL
);

INSERT INTO property_definitions_new (key, value_type, options, created_at)
    SELECT key, value_type, options, created_at FROM property_definitions;

DROP TABLE property_definitions;
ALTER TABLE property_definitions_new RENAME TO property_definitions;
```

### Optional follow-up: 0044_is_space_to_boolean.sql

Retype `is_space` from `select` to `boolean`. Migrate data: `WHERE value_text='true' SET value_bool=1, value_text=NULL`. **Defer** — separate plan after PEND-18 lands (avoids touching the spaces layer twice).

## Rust dispatch

The `PropertyValue` enum (live in `commands/blocks/crud.rs` or shared module) gets a new variant. Update every match arm. Files touched:

- `src-tauri/src/commands/properties.rs` — `set_property_in_tx`, `set_property_inner`, `get_properties_inner`, `get_properties_batch`. Add `value_bool: Option<bool>` parameter; update exactly-one-value validation to count `value_bool.is_some()`; update type matching for `"boolean"`.
- **`src-tauri/src/commands/properties.rs:566` — `create_property_def_inner` hardcoded match arm** (reviewer addition; was missing from the planner's draft). The function rejects unknown value types with a hardcoded `matches!(value_type.as_str(), "text" | "number" | "date" | "select" | "ref")`. Migration 0043 only updates the SQL CHECK constraint; the Rust validation is a separate gate. **Without updating this arm, `create_property_def('flag', 'boolean', ...)` returns `AppError::Validation` even after the migrations land.** This is a **blocker** for the plan.
- `src-tauri/src/commands/blocks/crud.rs` — `set_property_in_tx` type matching for `"boolean"` accepting only `value_bool`.
- `src-tauri/src/commands/mod.rs` — Tauri command handler signature.
- `src-tauri/src/op.rs` — `SetPropertyPayload` adds `value_bool: Option<bool>` field. **Must use `#[serde(default)]`** (reviewer addition; mirrors `DeleteAttachmentPayload.fs_path` pattern at `op.rs:226`). Without `#[serde(default)]`, old op-log entries without `value_bool` fail to deserialize on replay. Add a backward-compat round-trip test mirroring `delete_attachment_payload_legacy_json_deserializes_without_fs_path` (`op.rs:648-676`).
- `.sqlx/` cache — regenerate via `cargo sqlx prepare`.
- `PropertyRow` struct — add `value_bool: Option<i64>` (SQLite represents bool as 0/1).

## Frontend

Specta auto-derives. The TS `PropertyValue` becomes:

```typescript
type PropertyValue =
  | { Text: string }
  | { Number: number }
  | { Date: string }
  | { Ref: string }
  | { Boolean: boolean };
```

Frontend changes:

- `src/components/PropertyRowEditor.tsx` — checkbox/switch when `value_type === 'boolean'`.
- `src/components/AddPropertyPopover.tsx` — add `'boolean'` to the type-picker options.
- `src/components/PropertyValuePicker.tsx` — N/A unless agenda filters extend to booleans (defer).

## `is_space` retype — separable

Phase 1 (this plan) adds the boolean *type*. New properties can use it. `is_space` stays as `select` for backward compat.

Phase 2 (separate, deferred) retypes `is_space` to boolean. Touches every `is_space = 'true'` literal across the spaces query layer (~33 grep matches). Should land **after PEND-18** to avoid double-touching the spaces layer.

## Files touched

| File | Change |
| --- | --- |
| `migrations/0042_add_value_bool_column.sql` | New — column + index |
| `migrations/0043_property_definitions_allow_boolean.sql` | New — CHECK constraint update |
| `commands/properties.rs` | Add `value_bool` param + dispatch |
| `commands/blocks/crud.rs` | `set_property_in_tx` type matching |
| `commands/mod.rs` | Tauri handler signature |
| `op_log.rs` | `SetPropertyPayload` variant |
| `.sqlx/` | Regenerate |
| `PropertyRowEditor.tsx` | Checkbox UI for boolean |
| `AddPropertyPopover.tsx` | `'boolean'` in type picker |
| `bindings.ts` | Auto-regen via specta |

## Testing

- **Unit (Rust):** `set_property_inner` accepts `value_bool=Some(true)`/`Some(false)`, rejects mixing with other value_*. Round-trip serde for `PropertyValue::Boolean(_)`.
- **Integration:** create property def with `value_type='boolean'`, set on block, read back via `get_properties_inner`, assert `value_bool=1` and others NULL.
- **Migration test:** existing test pool with `value_type='select'` properties → run 0042 + 0043 → assert no data loss.
- **Snapshot:** `PropertyValue::Boolean(true|false)` serde shape via insta.
- **Frontend:** PropertyRowEditor renders `<input type="checkbox">` (or Switch) for `value_type='boolean'`.

## Cost (reviewer-revised)

**M (6.5-8h).**

| Step | Time |
| --- | --- |
| Migrations 0042 + 0043 | 0.5h |
| Rust dispatch (6 sites including the missing `create_property_def_inner` match arm) | 2.5h |
| sqlx regen + sqlx-prepare verification | 0.5h |
| Frontend (PropertyRowEditor + AddPropertyPopover) | 1h |
| Tests (unit + integration + snapshot + serde-backward-compat) | 2-2.5h |

## Impact

- **Immediate user impact: low.** No new boolean property is exposed yet (Phase 2 retypings deferred).
- **Long-term clarity: medium.** Property model becomes orthogonal. Future boolean properties (`template`, `archived`, `pinned`) become idiomatic.
- **Prerequisite for `is_space` retype** in a separate follow-up plan.

## Risk

**Low.** Additive change to enum + schema; existing properties unaffected. No breaking changes to the op log (new `value_bool` field is optional in payloads — old payloads without it deserialize cleanly to `value_bool: None`).

## Sequencing

- **Independent of PEND-18, PEND-12, PEND-13, PEND-15.** Can land in any order.
- **Prerequisite for the future `is_space` retype.** That retype should land AFTER PEND-18 to avoid stacking spaces-layer touches.
- **Unblocks future boolean properties** (`template`, `archived`, `pinned`) — those become idiomatic property definitions.

## Open questions

1. **Ternary boolean (NULL as third state)?** **Recommendation: no.** Strictly two-state (0/1). Absence of the property row = absence of value, distinct from `false`. Matches current `is_space` semantics (absent = not a space).
2. **Runtime conversion of existing select-with-one-option properties?** Probably not worth a UI affordance — different storage column. The migration path is per-property, deliberate.
3. **Are there other constraints on `property_definitions.value_type`?** Just the CHECK constraint (the migration 0043 covers it). Confirmed.
4. **Boolean property filtering in `query_by_property` / agenda filters?** **Defer to Phase 2+.** Today `query_by_property_inner` accepts only `value_text` and `value_date` (`commands/queries.rs:115-120`). Adding boolean filtering is its own plan after this lands.
5. **Boolean property sorting (`ORDER BY value_bool`)?** **Defer.** No current call site sorts on properties; if added later, the sort path will need a `value_bool` branch.
