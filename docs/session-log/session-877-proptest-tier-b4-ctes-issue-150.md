## Session 877 — proptest Tier B4: block_descendants / block_positions CTEs (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator + 1 build |
| **Items closed** | `#150` (final tier — closes the issue) |
| **Items modified** | — |
| **Tests added** | +3 proptest properties (192 generated cases) |
| **Files touched** | 2 |

**Summary:** Final tier of the DB-bound property-test coverage for issue #150. Adds three properties over the `block_descendants` CTEs and `block_positions` sibling logic, each validated against an independent in-memory oracle. With B4 landing (A shipped 2026-05-25; B1 session 870; B2 #187; B3 #186), **#150 is complete**. Test-only — no production changes.

**Files touched (this session):**
- `src-tauri/src/block_descendants.rs` (+`#[cfg(test)] mod proptest_b4;`)
- `src-tauri/src/block_descendants/proptest_b4.rs` (new, 3 properties × 64 cases)

**Properties (independent oracle each):**
1. `descendants_standard_matches_bfs_closure` — `descendants_cte_standard!` from every root vs a hand-rolled FIFO BFS over the parent map (exact id+depth).
2. `descendants_active_excludes_soft_deleted_subtrees` — `descendants_cte_active!` vs an active-BFS that emits the root unconditionally (the CTE base member has no `deleted_at` filter) but prunes whole soft-deleted subtrees; cross-checks subset-of-standard and no soft-deleted non-root node.
3. `next_sibling_position_never_collides` — `next_sibling_position_excluding_sentinel` vs a Rust `MAX(living, non-sentinel, same-parent) + 1`; generator sprinkles colliding positions, the `i64::MAX` sentinel, and soft-deleted nodes to exercise both exclusions.

**Verification:**
- `cargo nextest run block_descendants::proptest_b4` — 3 pass on two consecutive runs (~5.6s each).
- `cargo build --tests` — clean; `proptest_b4.rs` adds zero clippy warnings (method paths + `is_multiple_of` used to satisfy `-D warnings`).
- `.sqlx` cache unchanged (runtime `sqlx::query` only, no compile-time macros).
- pre-commit + pre-push hooks pass.

**Process notes:** The generator inserts directly into the `blocks` table (mirroring B3) since the shared op-log harness materialises `op_log`, not the `blocks` tree these CTEs walk. Notable production contract: the active descendants CTE emits a soft-deleted *root* at depth 0 (base member is unfiltered); only recursive descent is `deleted_at IS NULL`-filtered.

**Commit plan:** single commit / pushed. Closes #150.
