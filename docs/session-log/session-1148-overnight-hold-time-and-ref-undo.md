## Session 1148 — overnight batch loop: snapshot hold-time measurement + op-ref undo (2026-07-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-10 → 2026-07-11 (overnight, maintainer mandate ~21:10 UTC) |
| **Subagents** | 4 build + 3 review + 2 scout (1 reviewer lost to session limit, relaunched) |
| **Items closed** | #2470 (via PR #2534, merged), #2003 (already implemented — closed with evidence), #2468 + #2481 Phase 2 undo guard (via PR, this branch) |
| **Items modified** | filed #2535, #2549, #2555; commented #2003, #2470 |
| **Tests added** | +41 (frontend) / +21 (backend) + 1 criterion bench group |
| **Files touched** | ~30 across the two batches |

**Summary:** Batch 1 measured the `apply_snapshot` write-lock hold at vault scale (~18 s @
100K blocks release; a concurrent writer exhausts the 5 s `busy_timeout` and fails
`SQLITE_BUSY`), pinned `collect_tables` to a DEFERRED read connection, and updated the
operations doc — merged as PR #2534. Batch 2 converged page-level undo onto op-ref
addressing (#2468): `undo_op`/`undo_ops` ref-seeded commands over the shared
`revert_ops_in_tx` machinery, migration 0101 reverse-provenance columns
(maintainer-approved in-session), `WithOps<T>` op-ref capture on mutating commands via the
`LAST_APPEND` task-local, full `useUndoStore` migration with positional fallback for
ref-less flows, and `is_replicated = 0` guards on all implicit-undo queries (#2481 Phase 2).
The #2446 race class is pinned dead at both layers.

**Files touched (this session):**
- Batch 1 (PR #2534): `src-tauri/benches/snapshot_bench.rs`, `src-tauri/src/commands/tests/snapshot_restore_tests.rs`, `src-tauri/src/commands/history.rs` (clippy drive-by), `docs/architecture/operations.md`
- Batch 2: `src-tauri/migrations/0101_op_log_reverses_columns.sql` (new), `src-tauri/src/op_log/append.rs`, `src-tauri/src/commands/{history,mod,tags,properties}.rs`, `src-tauri/src/commands/blocks/{crud,move_ops}.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/tests/undo_redo_tests.rs`, `src/lib/{bindings,tauri}.ts`, `src/stores/{undo,page-blocks-reducers}.ts`, `src/hooks/useBlockTags.ts`, `src/hooks/useBlockDatePicker.ts`, `src/hooks/useBlockSlashCommands/*`, `src/components/pages/PageHeader.tsx`, `src/components/history/HistoryPanel.tsx`, `src/lib/tauri-mock/handlers.ts` + tests, `docs/architecture/editor-and-content.md`
- Process fixes: `scripts/check-session-log-numbering.sh` (new pre-commit guard), `prek.toml`, `docs/session-log/README.md`, `.claude/skills/batch-issues/references/session-log.md`

**Verification:**
- `cd src-tauri && cargo nextest run` — 5048 passed, 0 failed, 6 skipped.
- `npx tsc -b` clean; `npx vitest run` — 655 files, 14980 tests, all passed.
- `cargo clippy --all-targets -- -D warnings` clean; pre-commit + pre-push hooks green
  (zizmor offline mode — container egress blocks its tag listing).

**Process notes:** Adversarial review earned its cost twice. Batch 1: three measurement
defects fixed before any number reached docs (writer probe never overlapped the hold; bench
fixture's dangling `space_id` triggered the #708 repair pass, inflating 100K from ~18 s to
~47 s; test/bench fixture divergence). Batch 2: dishonest idempotent-no-op docs (real tag
commands error on duplicates — no migrated command returns empty `op_refs`), two
mock/backend divergences fixed, and the missing mixed-direction test (positional undo after
a ref-undo) added. Review also surfaced #2549 (`find_prior_*` ignores `is_replicated`) —
filed, out of scope.

**Lessons learned (for future sessions):**
- Session-log numbering: `ls | tail` sorts lexicographically and lied about the max
  (fifteen `session-1000` collisions repo-wide, this session nearly the fifteenth). Fixed
  structurally: numeric-max rule in README + skill reference, enforced by the new
  `session-log-numbering` pre-commit hook.
- Subagent cargo builds get auto-backgrounded by the harness and orphaned when the agent's
  turn ends — builders must keep reading the task output file in-turn; orchestrator owns
  long compiles.
- Remote-container gaps (missing lychee/sqruff, zizmor online audit vs egress policy) cost
  ~40 min — filed #2535 with SessionStart-hook fixes.
- Disk allowance (~9 GB writable) fills fast with release builds: delete
  `target/release` after benching and `target/debug/incremental` when squeezed; both
  regenerate.

**Commit plan:** split — batch 1 pushed + merged as PR #2534 (squash c48efb4); batch 2 as
three commits on `claude/2468-ref-undo` (feature, docs, review round + process fixes),
pushed with a draft PR.
