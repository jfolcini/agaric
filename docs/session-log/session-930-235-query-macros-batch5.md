## Session 930 — #235 query→macro conversion, batch 5 (final) (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 2 build + orchestrator central verify |
| **Items closed** | — (partial; #235 stays open for the #139-blocked dynamic remainder) |
| **Items modified** | #235 |
| **Tests added** | +0 (behaviour-preserving refactor; covered by existing 4067 tests) |
| **Files touched** | 2 source + 10 new `.sqlx` cache entries + 1 session log |

**Summary:** Fifth and final static-literal batch of #235 — 13 conversions in the snapshot-create and backlink-query modules. `block_descendants.rs` had no convertible sites (all `concat!()`-CTE or test). This drains the readily-convertible static-literal backlog in production code; the remainder is genuinely dynamic SQL (`concat!`/`AssertSqlSafe`/`format!`, the #139 space-filter cluster) plus the sensitive `op_log.rs` core, left for a dedicated pass.

**Files touched (this session):**
- `src-tauri/src/snapshot/create.rs` (9 sites) — `log_snapshots` INSERT/UPDATE, op_log compaction DELETEs, property/alias snapshot SELECTs.
- `src-tauri/src/backlink/query.rs` (4 sites) — backlink COUNT scalars + property-key DISTINCT (the rest are `AssertSqlSafe(format!())` dynamic, OUT).
- `src-tauri/.sqlx/` (+10 cache entries, 0 deletions).

**Verification:**
- `cd src-tauri && cargo check --all-targets` — clean.
- `cd src-tauri && cargo nextest run` — 4067 passed, 6 skipped.
- `cargo sqlx prepare -- --all-targets` — 10 new entries, no deletions.

**Process notes:** #235 static-literal conversion across batches 1–5 (#303–#307): **170 sites** converted to compile-time-checked macros, every batch gated by the full 4067-case nextest suite, all behaviour-preserving. Each batch branched independently off `origin/main` with disjoint source files; `.sqlx` additions are per-query-hash files so all five PRs land independently despite all touching `src-tauri/.sqlx/`. Remaining #235 scope = dynamic SQL tracked under #139 + the `op_log.rs` append-only core (deferred — too sensitive for a mechanical sweep).

**Commit plan:** single commit / pushed.
