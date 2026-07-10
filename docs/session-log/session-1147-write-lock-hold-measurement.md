## Session 1147 — apply_snapshot hold-time measurement + collect_tables pin (#2470) (2026-07-10)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-10 |
| **Subagents** | 3 build + 1 review (across 2 issues; one issue resolved with no code) |
| **Items closed** | #2470 |
| **Items modified** | #2003 (no code — verified items 2+3 already shipped via #2499; corrected the issue thread) |
| **Tests added** | +0 (frontend) / +2 (backend: 1 CI-gating pin, 1 `#[ignore]`-d measurement harness) |
| **Files touched** | 4 |

**Summary:** Closed out #2470's remaining scope. `collect_tables` never needing the
write lock is now pinned by a CI-gating test; `apply_snapshot`'s hold is measured by two
committed harnesses sharing an identical fixture (criterion release bench: ~120 ms @ 1K,
~1.1 s @ 10K, ~18 s @ 100K; dev-profile in-test measurement: ~6 s @ 100K with a concurrent
writer probe that waited the full 5 s `busy_timeout` and failed `SQLITE_BUSY`).
`operations.md` § Write-lock hold-time contract now states the measured contract instead
of the "not measured / not yet written" hedges. Also picked up #2003 items 2+3, then
discovered they had already merged via PR #2499 — un-claimed with a correcting status
comment; only saved views (gated on `PagesFilterSet`) remains there.

**Files touched (this session):**
- `src-tauri/src/snapshot/tests.rs` (+~214: `collect_tables_runs_on_deferred_connection_2470`, `measure_apply_snapshot_write_lock_hold_2470`, shared `vault_scale_snapshot_2470` fixture)
- `src-tauri/benches/snapshot_bench.rs` (+~82: `apply_snapshot_vault_scale` criterion group; dedicated no-dangling-`space_id` fixture)
- `docs/architecture/operations.md` (measured hold-time contract; pinned-invariant wording; writer-probe cross-reference)
- `docs/session-log/session-1147-write-lock-hold-measurement.md` (this file)

**Verification:**
- `cd src-tauri && cargo nextest run` — 5010 run, 5009 passed, 1 failed (`unwritable_log_dir_degrades_without_panic` — environmental: sandbox runs as root so chmod-based denial doesn't apply; fails identically on the pristine tree).
- `cargo nextest run --run-ignored all -E 'test(/2470/)'` — 2/2 pass, measurement numbers captured.
- `cargo bench --bench snapshot_bench -- apply_snapshot_vault_scale` — release-profile figures captured post-fixture-fix.
- pre-commit / pre-push hooks — run at commit/push time.

**Process notes:** Adversarial review earned its cost again: it confirmed and fixed three
measurement defects (writer probe never overlapped the hold — rewritten as a
max-wait-over-lifetime loop; bench fixture's dangling `space_id` forced the #708 repair
pass to rewrite every row, inflating 100K from ~18 s to ~47 s; test/bench fixture
divergence). First numbers out of a measurement harness should never go straight to docs.

**Lessons learned (for future sessions):** (1) The cross-session claim check must also
search MERGED PRs / `git log` for the issue number — #2003's slice was already shipped and
only the open-PR check ran. (2) Subagents die when long cargo runs get auto-backgrounded
by the harness; the orchestrator should own every long compile/bench as a tracked
background task and let subagents only edit files + run fast targeted tests.

**Commit plan:** single commit, pushed to `claude/2470-hold-time`, PR with `Closes #2470`.
