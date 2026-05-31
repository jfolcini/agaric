## Session 926 — #235 query→macro conversion, batch 1 (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 3 build (one per file) + orchestrator central verify |
| **Items closed** | — (partial; #235 stays open) |
| **Items modified** | #235 |
| **Tests added** | +0 (behaviour-preserving refactor; covered by existing 4067 tests) |
| **Files touched** | 3 source + 28 new `.sqlx` cache entries + 1 session log |

**Summary:** Converted 40 static-literal runtime sqlx queries (`sqlx::query(_as/_scalar)::<…>("LIT")`) to their compile-time-checked macro forms (`query!`/`query_scalar!`/`query_as!`) across three `commands/` files, gaining schema validation against `.sqlx`. First batch of #235's ~206-site backlog; out-of-scope sites (`concat!`-composed, `AssertSqlSafe`/`format!`-dynamic, PRAGMA/DDL, test code) were left untouched per the issue's IN/OUT criteria.

**Files touched (this session):**
- `src-tauri/src/commands/blocks/crud.rs` (16 sites; +/-130)
- `src-tauri/src/commands/history.rs` (15 sites; +/-214)
- `src-tauri/src/commands/pages.rs` (9 sites; +/-89)
- `src-tauri/.sqlx/` (+28 cache entries, 0 deletions)

**Verification:**
- `cd src-tauri && cargo check --all-targets` — clean (no errors/warnings).
- `cd src-tauri && cargo nextest run` — 4067 tests run, 4067 passed.
- `cargo sqlx prepare -- --all-targets` — 28 new entries, no deletions (test/bench queries preserved).
- pre-commit / pre-push hooks — gated at commit/push time.

**Process notes:** Tuple-typed `query_as::<_, (A,B,C)>` sites cannot use `query_as!` (sqlx 0.9.0 requires a named-struct path, not a tuple); converted those to `query!` (anonymous record) + an explicit `.map(...)` rebuilding the identical tuple, preserving signatures. No nullability overrides were needed except a handful of `AS "col!"`/`AS "col?: T"` where sqlx's schema-inferred nullability differed from the old turbofish type (COUNT/EXISTS comparisons, custom-type columns in `PageLink`).

**Lessons learned (for future sessions):** Concurrent same-crate build subagents share one cargo target — one agent transiently observed another's mid-edit and misread it as "pre-existing WIP"; the central `cargo check --all-targets` + nextest is the arbiter, not any single subagent's snapshot. Regenerate `.sqlx` with `-- --all-targets` (not bare `cargo sqlx prepare`, which prunes test-query entries → spurious mass deletions).

**Commit plan:** single commit / pushed.
