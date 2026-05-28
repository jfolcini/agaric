## Session 824 — PEND-69 hygiene: Rust `dead_code` audit (2026-05-23)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-23 |
| **Subagents** | orchestrator-only (per-case judgment + iterative clippy) |
| **Items closed** | PEND-69 `dead_code` category (audited all ~23 allows) |
| **Items modified** | PEND-69 (table row + action order) |
| **Tests added** | 0 (hygiene; `cargo nextest` 3956 still pass) |
| **Files touched** | 4 src-tauri + 2 plan/log |

**Summary:** Second PEND-69 burn-down batch — audited every `#[allow(dead_code)]`
in `src-tauri`. **Deleted** the genuinely-dead `apply_purge_block_sql_only`
wrapper in `materializer/handlers.rs` (zero callers; a thin pass-through to the
live `purge_block_sql_cascade`, whose doc was preserved). **Converted 3** never-
read intentional keeps from `#[allow]` to `#[expect(dead_code, reason)]` so they
self-report if they ever go live: the `SyncOrchestrator::materializer` field
(held for API stability), `dag.rs`'s `depth` (selected only for SQL `ORDER BY`),
and `db.rs`'s `CommandTx::label` (reserved for a planned Drop-time debug-assert).
The remaining ~19 `#[allow(dead_code)]` were reviewed and confirmed JUSTIFIED
keeps (documented scaffolding, `gcal_push` test-shims, `mcp::SocketKind` platform
variants, `cfg_attr(not(test))`-scoped helpers, specta-read `AppErrorSchema`,
`recurrence::handle_recurrence` kept as future API + test helper, `is_empty`/`len`
symmetry).

**Done orchestrator-direct** — per-case wire/scope/delete judgment with iterative
clippy, not delegable; `src-tauri`-only so conflict-free with the frontend agent.

**REVIEW-LATER impact:**
- **PEND-69:** `dead_code` row marked audited (23 → ~19 justified keeps);
  action-order item 4 done. Remaining PEND-69 targets:
  `cast_possible_truncation` (11), prod `noExplicitAny` (11) +
  `noDangerouslySetInnerHtml` (2), the `useExhaustiveDependencies` audit (59).
- **Previously resolved:** 1336+ → 1337+ across 823 → 824 sessions.

**Files touched (this session):**
- `src-tauri/src/materializer/handlers.rs` (deleted dead wrapper; doc moved to `purge_block_sql_cascade`)
- `src-tauri/src/sync_protocol/orchestrator.rs`, `src-tauri/src/dag.rs`, `src-tauri/src/db.rs` (`#[allow]` → `#[expect(dead_code, reason)]`)
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md`

**Verification:**
- `cargo fmt --check` — clean.
- `cargo clippy --all-targets --all-features --no-deps` — No issues found (all three `#[expect]`s fulfilled; no `unfulfilled_lint_expectations`).
- `cargo nextest run` — 3956 passed, 6 skipped.
- `prek run` on the staged files — all hooks pass.

**Lessons learned:** `#[expect(dead_code)]` is only safe for code dead in EVERY
compiled config — `clippy --all-targets` includes tests, so an item used by a
test (e.g. `handle_recurrence`) must stay `#[allow]` (or `cfg_attr(not(test),
allow)`), not `#[expect]`, or it trips `unfulfilled_lint_expectations`.

**Commit plan:** single commit (PEND-69 dead_code). Not pushed.
