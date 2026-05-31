## Session 928 — #235 query→macro conversion, batch 3 (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 3 build (one per file) + orchestrator central verify |
| **Items closed** | — (partial; #235 stays open) |
| **Items modified** | #235 |
| **Tests added** | +0 (behaviour-preserving refactor; covered by existing 4067 tests) |
| **Files touched** | 3 source + 37 new `.sqlx` cache entries + 1 session log |

**Summary:** Third batch of #235 — converted 42 static-literal runtime sqlx queries to compile-time macros in the materializer, recurrence, and snapshot-restore modules (disjoint from batches 1–2). `materializer/handlers.rs` (26), `snapshot/restore.rs` (11), `recurrence/compute.rs` (5).

**Files touched (this session):**
- `src-tauri/src/materializer/handlers.rs` (26 sites; +/-272) — pages_cache/blocks/tags/properties/attachments DML; tuple `query_as` → `query!` + `.map()`; `AS "col!"` casts on the `IS NOT NULL`-filtered SELECTs.
- `src-tauri/src/snapshot/restore.rs` (11 sites; +/-22) — table-clear DELETEs + draft-count scalar (`AS "count!"`).
- `src-tauri/src/recurrence/compute.rs` (5 sites; +/-35) — repeat-rule property scalars (`.flatten()` over nullable columns).
- `src-tauri/.sqlx/` (+37 cache entries, 0 deletions).

**Verification:**
- `cd src-tauri && cargo check --all-targets` — clean.
- `cd src-tauri && cargo nextest run` — 4067 passed, 6 skipped.
- `cargo sqlx prepare -- --all-targets` — 37 new entries, no deletions.

**Process notes:** OUT-of-scope sites left untouched per #235: `materializer/handlers.rs` keeps the `concat!()`-CTE statements and the purge-cascade DELETEs that read from a runtime-created `_purge_descendants` TEMP table (sqlx's compile-time checker can't resolve a temp table); `snapshot/restore.rs` keeps the PRAGMA and the `AssertSqlSafe(format!())` dynamic-table-name statements.

**Commit plan:** single commit / pushed.
