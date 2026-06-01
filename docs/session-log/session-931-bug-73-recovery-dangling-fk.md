## Session 931 — BUG-73 recovery: skip dangling FK refs instead of crashing (2026-06-01)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-01 |
| **Subagents** | orchestrator (this fix) + 1 background batch-issues worktree |
| **Items closed** | follow-up to #310 (migration-73 recovery) |
| **Items modified** | `src-tauri/src/db.rs` |
| **Tests added** | +1 (`init_pool_recovery_skips_dangling_fk_refs_73`) |
| **Files touched** | 1 source + 1 session log |

**Summary:** The op_log recovery merged in #310 still crashed at startup. Local AppImage logs showed the new recovery path running (`Replaying 4123 ops` → migrations complete → `recovering properties and tags`) and then panicking with `FOREIGN KEY constraint failed (787)`. Root cause: `recover_derived_state_from_op_log` replayed `set_property`/`add_tag` ops into `block_properties`/`block_tags` with plain `INSERT ... VALUES`, never checking that the referenced blocks still exist. With `PRAGMA foreign_keys = ON`, an op referencing a purged block — or a block created on another device and absent from the local op_log — trips the FK constraint and aborts the whole setup hook. `recover_blocks_from_op_log` already cleaned orphaned `parent_id`s, but the derived-state pass had no equivalent guard.

**Fix:** Both inserts rewritten as `INSERT ... SELECT ... WHERE EXISTS`:
- `block_properties`: insert only if the owning `block_id` exists **and** (`value_ref` is NULL **or** the referenced block exists). A dangling `value_ref` skips the whole row — under the exactly-one-value invariant (migration 0062) `value_ref` is the row's sole value and its FK is `ON DELETE CASCADE`, so nulling it would just trade FK 787 for a CHECK violation on an all-NULL row.
- `block_tags`: insert only if both `block_id` and `tag_id` exist.

**Files touched (this session):**
- `src-tauri/src/db.rs` — guarded the two derived-state inserts; added regression test seeding `set_property`/`add_tag`/`value_ref` ops against missing blocks, dropping `blocks`, and asserting reopen succeeds with valid rows recovered and dangling ones skipped.

**Verification:**
- `cd src-tauri && cargo nextest run` — 4070 passed, 0 failed.
- `cargo fmt --check` — clean.
- New test fails (FK 787 panic) without the guards, passes with them.

**Release:** recovery code (#310) was merged *after* the 0.3.1 tag, so it has never shipped — this fix plus #310 release together as 0.3.2.
