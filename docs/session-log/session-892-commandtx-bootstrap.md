## Session 892 — #110 batch 2: bootstrap coupled dispatch (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#110` |
| **Tests added** | +0 (existing bootstrap/spaces tests adapted) |
| **Files touched** | 8 |

**Summary:** Second #110 (finish MAINT-112) sub-batch, maintainer decision group-1 "(b)". Both boot-path
functions — `bootstrap_spaces` and `migrate_personal_pages_to_work` — previously emitted op_log ops
(CreateBlock for spaces, SetProperty `is_space`/`accent_color`, page-rebind) via
`append_local_op_in_tx`/`set_property_in_tx` but **discarded the returned `OpRecord`s** and committed
via raw `BEGIN IMMEDIATE`. They now use `CommandTx::begin_immediate`, collect each emitted `OpRecord`
(the helper fns gained a `records: &mut Vec<OpRecord>` out-param), `enqueue_background` in emission
order, and `commit_and_dispatch(materializer)`. `&Materializer` is threaded from the `lib.rs` boot
sequence (live well before these calls; `commit_and_dispatch` uses a non-blocking `try_send`, so no
boot deadlock). The concurrent-loser path in `migrate_personal_pages_to_work` still `rollback()`s.

Built in an **isolated git worktree** concurrently with the frontend prefer-tag batch (per the
session-889 stash lesson — separate worktrees, no shared-tree git ops).

**Files touched:** `spaces/bootstrap.rs` (the two fns + 5 emitting helpers + `*_for_test` shims),
`spaces/mod.rs` (re-export shim), `lib.rs` (thread materializer at both call sites), and test call
sites in `commands/spaces.rs`, `commands/tests/block_cmd_tests.rs`, `integration_tests.rs`,
`mcp/tools_ro/tests.rs`, `spaces/tests.rs`.

**Verification:**
- `cargo nextest run bootstrap` (19/19), `cargo nextest run spaces` (67/67), `cargo nextest run -p agaric` 4067 passed; `cargo check --tests` clean.
- Review subagent (≠ builder) — APPROVE; confirmed boot-safety (materializer live before calls, non-blocking dispatch), every OpRecord enqueued exactly once in order, behavior preserved, deref levels correct.

**Process notes:** Per-op dispatch is ADDITIVE to the broad post-bootstrap rebuilds in `lib.rs`
(idempotent, both post-commit). The unconditional `RebuildPageIds` (lib.rs) is **NOT** redundant —
on steady-state boots bootstrap emits no ops, so it's the only thing scheduling that rebuild; kept.
**Remaining #110:** soft_delete 8-task realign (group 2 "b"), prek lint hook.

**Commit plan:** single commit, pushed, PR opened (Refs #110 — partial; issue stays open).
