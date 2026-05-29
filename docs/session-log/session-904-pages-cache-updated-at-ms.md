## Session 904 — #109 Phase 2: pages_cache.updated_at → INTEGER ms (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2, table 5 of ~10) |
| **Tests added** | 0 (existing cache/materializer/snapshot suites cover it; fixtures updated) |
| **Files touched** | 11 |

**Summary:** Fifth table of #109 Phase 2 — migrate `pages_cache.updated_at` from TEXT
(RFC 3339) to INTEGER epoch-ms. `pages_cache` is a derived, rebuildable cache; `updated_at`
is self-generated at both write sites (the `rebuild_pages_cache_impl` stamp and the
materializer's post-`CreateBlock` `INSERT OR IGNORE`, both `now_rfc3339()` — verified NOT
op-sourced), and the M-2 "preserve `updated_at` unless title changed" recency semantic
compares the value only to itself. So it's independent of the `op_log.created_at` cluster.

**Files touched (this session):**
- `src-tauri/migrations/0078_pages_cache_updated_at_ms.sql` (new — rebuild, STRICT, `CHECK >= 0`, preserves FK→blocks CASCADE + `inbound_link_count`/`child_block_count` + `idx_pages_cache_title_nocase`; `julianday` backfill)
- `src-tauri/src/cache/pages.rs` (`apply_sort_merge_rebuild(now: &str → i64)`; both rebuild impls `now_ms()`; M-2 test `snapshot_with_ts` tuple `→ (String, String, i64)` + `ts_for`/`ts_after_for` closures `→ i64`)
- `src-tauri/src/materializer/handlers.rs` (production post-CreateBlock pages_cache write: `now_rfc3339()` → `now_ms()`)
- test fixtures across `op_log.rs`, `cache/cascade_tests.rs`, `command_integration_tests/block_integration.rs`, `commands/tests/{glob_filter,list_pages_with_metadata}_tests.rs`, `materializer/tests.rs`, `snapshot/tests.rs`, `filters/primitive.rs` (epoch-ms literals/binds)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, 0 warnings.
- `cargo nextest run cache:: pages snapshot:: glob_filter list_pages_with_metadata primitive command_integration materializer op_log filters block_integration` — all pass (1035 across the two runs).
- `.sqlx` regen produced no diff (reads are runtime queries; the macro cache key is the unchanged query string). Not IPC-exposed — no bindings/FE.

**Process notes:** STRICT again surfaced every leftover writer — including a **production**
materializer write (`handlers.rs:768`) and inserts spread across 8 test files; a whole-tree
`INTO pages_cache` grep (not just the table's module) was essential. `pages_cache.updated_at`
is *written by the materializer* but from a self-generated `now`, not the op timestamp — so
unlike `attachments.created_at` it is NOT part of the op_log cluster.

**Commit plan:** single commit / pushed.
