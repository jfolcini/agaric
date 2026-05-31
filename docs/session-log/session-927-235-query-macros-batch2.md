## Session 927 — #235 query→macro conversion, batch 2 (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 3 build (one per file) + orchestrator central verify |
| **Items closed** | — (partial; #235 stays open) |
| **Items modified** | #235 |
| **Tests added** | +0 (behaviour-preserving refactor; covered by existing 4067 tests) |
| **Files touched** | 2 source + 20 new `.sqlx` cache entries + 1 session log |

**Summary:** Second batch of #235 — converted 27 static-literal runtime sqlx queries to compile-time macros in the FTS index and Loro-projection modules (disjoint from batch 1's `commands/` files). `fts/index.rs` (11) and `loro/projection.rs` (16); `db.rs` had no in-scope sites (its runtime queries are all PRAGMA or test-only). Gains compile-time schema validation against `.sqlx`.

**Files touched (this session):**
- `src-tauri/src/fts/index.rs` (11 sites; +/-77) — FTS5 virtual-table DML incl. the `INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')` special command; `reindex_fts_references` row loop rewritten to named struct fields.
- `src-tauri/src/loro/projection.rs` (16 sites; +/-173) — op-projection INSERT/UPDATE/DELETE + reprojection helpers.
- `src-tauri/.sqlx/` (+20 cache entries, 0 deletions).

**Verification:**
- `cd src-tauri && cargo check --all-targets` — clean.
- `cd src-tauri && cargo nextest run` — 4067 tests run, 4067 passed.
- `cargo sqlx prepare -- --all-targets` — 20 new entries, no deletions.

**Process notes:** Left out-of-scope sites untouched per #235 criteria: `loro/projection.rs` keeps 3 `concat!()`-built CTE statements (L244/L307/L825); `fts/index.rs` keeps the `QueryBuilder`/`push_values` dynamic multi-row INSERT. No nullability overrides were needed — macro-inferred types matched the prior turbofish types throughout. The `.sqlx` cache is one JSON file per query hash, so these additions are disjoint from batch 1 (#303) — both PRs can land independently despite both touching `src-tauri/.sqlx/`.

**Commit plan:** single commit / pushed.
