# #109 Phase 2 — op_log/blocks/attachments/block_drafts cluster: type convention

Hard cutover (maintainer 2026-05-29). Migrations 0079–0082 (verified-applying)
flip 4 columns to INTEGER epoch-ms. The Rust propagation MUST follow this fixed
convention so it converges (the earlier attempt oscillated by flip-flopping
helper/cursor signatures):

## Type rules (apply once, do not deviate)

1. **DB FromRow row structs → `i64` / `Option<i64>`** for these columns only:
   - `OpRecord.created_at: i64` (op_log.rs)
   - `BlockRow.deleted_at: Option<i64>`, `ActiveBlockRow.deleted_at: Option<i64>`,
     `HistoryEntry.created_at: i64` (pagination/mod.rs)
   - `Draft.updated_at: i64` (draft.rs)
   - the attachment row struct `created_at: i64` (commands/mod.rs etc.)
   - row structs in queries.rs / pages.rs / fts/search.rs / fts/toggle_filter.rs
     `deleted_at: Option<i64>`
2. **Op payload**: `RestoreBlockPayload.deleted_at_ref: i64` (op.rs) — matched
   against `blocks.deleted_at`, sourced from the delete op's `created_at`.
3. **Wire**: `OpTransfer.created_at: i64` (sync_protocol/types.rs).
4. **Snapshot**: `BlockSnapshot.deleted_at: Option<i64>`, `AttachmentSnapshot.created_at: i64`
   (snapshot/types.rs). `AttachmentSnapshot.deleted_at` STAYS `Option<String>`.
5. **Pagination `Cursor.deleted_at` STAYS `Option<String>`** — opaque keyset slot
   that carries blocks.deleted_at / op_log.created_at / due_date / agenda-date as
   serialized strings. BRIDGE at the boundary:
   - encode (row→cursor): `Some(row.deleted_at_i64.to_string())` / `created_at.to_string()`
   - decode (cursor→SQL bind): when the query orders by an i64 column, `.parse::<i64>()`
     the slot before binding; date-string queries (agenda/due_date) bind the slot as-is.
   - `Cursor` builder helpers (`for_id_and_deleted_at`, `for_history_full`) keep
     `String` slots; callers stringify.
6. **Producers**: `crate::now_rfc3339()` → `crate::db::now_ms()` ONLY where the value
   feeds one of the 4 migrated columns or `deleted_at_ref`. Append fns take `created_at: i64`.
7. **Comparisons**: i64 arithmetic; delete `parse_from_rfc3339` / `ends_with('Z')` /
   RFC3339 formatting for these fields. recovery's `created_at > ?` binds i64.
8. **FE**: the 4 IPC types in bindings.ts (`created_at`/`deleted_at`) → `number`; update
   tauri.ts hand types + consumers; regen Specta bindings.

## DO NOT TOUCH (still TEXT)

gcal_* modules; `due_date` / `scheduled_date` (date strings); `attachments.deleted_at`;
agenda-cache date strings; tags_cache / already-migrated caches.

## Verify

`cargo check --all-targets` (ONLINE: DATABASE_URL=sqlite:dev.db with 0079-0082 applied,
SQLX_OFFLINE unset — so query! macros validate against the INTEGER schema) → 0; then
`cargo sqlx prepare -- --tests`; `cargo test specta_tests -- --ignored` (bindings);
`cargo nextest run` (full suite is the correctness arbiter); FE `tsc` + `vitest`.

## Test-fixture ms constants (UTC)

2025-01-15T12:00:00Z=1736942400000  2025-01-01T00:00:00Z=1735689600000
2025-06-01T00:00:00Z=1748736000000  2024-01-01T00:00:00Z=1704067200000
2099-01-01T00:00:00Z=4070908800000  1970-01-01=0
