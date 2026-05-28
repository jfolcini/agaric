## Session 871 — Fix reverse_set_property ignoring delete_property (issue #181) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | 1 build (orchestrator-reviewed) |
| **Items closed** | `#181` |
| **Items modified** | — |
| **Tests added** | +0 (un-ignored 1 pinned regression test; re-enabled the proptest `DeleteProperty` generator arm) |
| **Files touched** | 4 (+1 `.sqlx` swapped) |

**Summary:** Fixed the production bug #150's B1 inverse-law property caught (#181): `reverse::reverse_set_property` resurrected a stale pre-delete value because `find_prior_property` queried only `set_property` ops, ignoring an intervening `delete_property`. Now the reverse of a set-after-delete is correctly `DeleteProperty`.

**Files touched (this session):**
- `src-tauri/src/reverse/property_ops.rs` — `find_prior_property` now selects the single most-recent prior op of EITHER type (`op_type IN ('set_property','delete_property')`, same ordering + `LIMIT 1`) and reads `op_type`: a prior `delete_property` (or no prior op) → prior state ABSENT → returns `None`, so `reverse_set_property` emits `DeleteProperty`. Keeps `reverse_delete_property` correct (the existing `NotFound` guard still fires).
- `src-tauri/.sqlx/` — 1 query cache entry swapped (SELECT widened to include `op_type`).
- `src-tauri/src/reverse/proptest_b1.rs` — removed `#[ignore]` from `regression_reverse_set_property_after_delete_should_be_delete` (now passes in the normal suite).
- `src-tauri/src/proptest_db_harness.rs` — re-enabled the `DeleteProperty` generator arm (weight 1) that was commented out pending this fix.

**Verification:**
- `cd src-tauri && cargo nextest run` — 4057 passed, 6 skipped, 0 failed.
- Regression test confirmed failing under `--run-ignored` before the fix; passes after.
- Inverse-law proptest (`compute_reverse_obeys_inverse_law`) green with `DeleteProperty` active, incl. stress at `PROPTEST_CASES=512`.
- `cargo sqlx prepare -- --tests` — `.sqlx/` regenerated for the widened query.
- pre-commit hook — staged-file checks. pre-push hook — full clippy + push-staged checks.

**Process notes:** This closes the loop on the bug that #150's harness discovered and pinned — the harness's `DeleteProperty` generator arm is now active, so future regressions in this path are caught by the random inverse-law property, not just the one pinned case.

**Commit plan:** single commit, pushed; PR closes #181.
