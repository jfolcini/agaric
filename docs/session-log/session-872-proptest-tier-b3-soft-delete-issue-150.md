## Session 872 — proptest Tier B3: soft_delete cascade/restore (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 verification (no build subagent — work was pre-staged) |
| **Items closed** | — |
| **Items modified** | `#150` (Tier B3 of 4) |
| **Tests added** | +0 (frontend) / +3 proptest properties (backend, 192 generated cases) |
| **Files touched** | 2 |

**Summary:** Added property-test coverage for the `soft_delete` cascade/restore logic (Tier B3 of issue #150), building on the seeded-DB harness landed in B1. Three properties exercise cascade idempotence, `restore ∘ cascade == identity` on a clean subtree, and subtree isolation, each validated against an independent hand-rolled BFS oracle rather than production code. Test-only — no production changes.

**Files touched (this session):**
- `src-tauri/src/soft_delete/mod.rs` (+`#[cfg(test)] mod proptest_b3;`)
- `src-tauri/src/soft_delete/proptest_b3.rs` (new, 3 properties × 64 cases)

**Verification:**
- `cd src-tauri && cargo nextest run` — 4060 passed, 6 skipped, 0 failed (one pre-existing unrelated integration flaky self-recovered on retry). The 3 B3 proptests pass (~31s each, marked SLOW).
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:** Work was inherited pre-staged in worktree `agaric-wt-b3`; this session verified, logged, and shipped it. #150 still has Tier B2 (dag) and B4 (CTEs) outstanding — issue stays open.

**Commit plan:** single commit / pushed.
