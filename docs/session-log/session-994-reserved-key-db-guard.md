## Session 994 — reserved-property keys: DB-enforced single source of truth (2026-06-07)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-07 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#534` |
| **Items modified** | — |
| **Items filed** | `#587`, `#588`, `#589` |
| **Tests added** | +3 (backend) |
| **Files touched** | ~12 |

**Summary:** Closed #534 (the four fixed properties `todo_state`/`priority`/`due_date`/`scheduled_date` plus `space` having a potential third source of truth in `block_properties`). The live routing already kept these in their dedicated `blocks` columns, so the actionable gap was the *robustness* the issue flagged: nothing structurally prevented a stale shadow row. Migration 0088 promotes the runtime `is_reserved_property_key()` gate into a storage-layer `CHECK (key NOT IN (...))` on `block_properties` (via the canonical table rebuild + a defensive cleanup `DELETE`). The op-log recovery replay in `db.rs` — which *did* write these keys into `block_properties` — was rerouted to the columns, mirroring the live projection.

**Why CHECK over a trigger:** follows the precedent of migration 0085 (it promoted the `block_type` guard from triggers to a CHECK precisely because triggers must be re-created on every table rebuild, a per-rebuild vigilance tax). `block_properties` is rebuilt periodically (0061, 0062), so a CHECK is the consistent, lower-maintenance choice.

**Files touched (this session):**
- `src-tauri/migrations/0088_block_properties_reserved_key_guard.sql` (new) — table rebuild adding `key_not_reserved` CHECK + cleanup DELETE.
- `src-tauri/src/db.rs` — recovery replay routes reserved keys (set/clear/delete) to `blocks` columns; `space` clears/sets fan out to the owning-page group (`WHERE id = ? OR page_id = ?`); +3 tests.
- `src-tauri/benches/snapshot_bench.rs` — fixed pre-existing #533 leftover (`BlockSnapshot` missing `space_id`); space modelled via the column, generic property row kept for codec coverage.
- Test seeds converted off reserved/space keys in `block_properties`: `src/backlink/tests.rs`, `src/cache/cascade_tests.rs`, `src/integration_tests.rs`, `src/command_integration_tests/{block,trash}_integration.rs`, `src/pagination/tests.rs`, `src/gcal_push/connector.rs`, `src/commands/tests/page_cmd_tests.rs`.

**Tests added:**
- `db::tests::block_properties_rejects_reserved_key_534` — the CHECK aborts a direct reserved-key insert (and a non-reserved key still inserts).
- `db::tests::recovery_set_space_fans_out_to_page_group_534` — recovery of `set_property(space)` fans `space_id` out to descendants.
- `db::tests::recovery_clear_space_fans_out_to_page_group_534` — recovery of `delete_property(space)` clears descendants too (regression for the fan-out bug an adversarial review caught).

**Review finding (fixed):** the recovery `space` *clear* originally nulled only the page row (`WHERE id = ?`) while every live clear path fans out to the page group — would have stranded descendants with a stale `space_id` after a recovery. Fixed both clear sites + added the regression test.

**Issues filed (drive-by, schema review):**
- `#587` (`sql`,`idea`) — `block_properties.value_num REAL` loses integer fidelity; decide `value_int` arm vs document-as-intentional.
- `#588` (`sql`) — document `due_date`/`scheduled_date`/`value_date` as intentionally TEXT calendar dates (SQLite has no date type), excluded from the epoch-ms migration.
- `#589` (`sql`,`rust`) — the reserved-key set is duplicated across Rust + the SQL CHECK with no drift guard; single-source the Rust side + a test pinning it against the DB constraint.
