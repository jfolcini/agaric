## Session 856 — schema CHECK for the pages.page_id invariant via blocks table rebuild (closes #111) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | 1 Explore (read-only schema audit) + orchestrator-direct migration + tests |
| **Items closed** | #111 (Close pages.page_id invariant gap — Path A: schema CHECK via blocks table rebuild) |
| **Items modified** | — |
| **Tests added** | +4 backend (`cache/page_id.rs::tests` — fresh-DB parity, CHECK rejects mismatched page_id, non-page rows exempt, well-formed page rows succeed) |
| **Files touched** | 3 |

**Summary:** Closes #111 via the maintainer-approved Path A — promote the "every `block_type = 'page'` row carries `page_id = id`" invariant from a Rust-side write-time check into a storage-layer `CHECK` constraint by rebuilding the `blocks` table. Migration 0066 had backfilled `page_id = id` for every page row but explicitly deferred the CHECK promotion (it required a full table rebuild and the invariant was assumed to be enforced upstream). #111 reopened that decision because at least one write site (`apply_create_block_sql_only`) skipped the Rust enforcement, and any future write path bypassing `create_block_in_tx` would silently regress without a schema-level guard.

The new migration `0073_blocks_check_page_id_invariant.sql` follows the canonical 12-step SQLite table-rebuild recipe (in-repo precedent: migrations 0061 and 0062). The `blocks` table is the FK parent of ~14 referencing tables, so the rebuild relies on commit-time FK validation — between the DROP and the RENAME the FK target is briefly missing, but no data manipulation runs during that window and at commit time the renamed `_new_blocks` is back in place with the same row set, so every referencing FK re-resolves by name. The two `BEFORE` triggers from migration 0005 (`check_block_type_insert` / `check_block_type_update` enforcing the enum) are dropped along with the old table and recreated verbatim against the renamed table; the 9 live indexes from migrations 0001/0012/0013/0023/0024/0027/0047 are recreated in their original definitions.

**Out of scope (deliberately):** the migration preserves the implicit `ON DELETE` semantics on `parent_id` and `page_id` self-FKs unchanged. Promoting those to explicit `ON DELETE CASCADE` would change hard-delete behaviour (parent deletion would propagate to children) and is a separate decision orthogonal to #111.

**Files touched (this session):**
- `src-tauri/migrations/0073_blocks_check_page_id_invariant.sql` (new — ~150 lines incl. detailed header comment)
- `src-tauri/src/cache/page_id.rs` (+ `#[cfg(test)] mod tests` with 4 regression tests)
- `docs/session-log/session-856-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo sqlx prepare -- --tests` — no new compile-time queries; the tests use runtime `sqlx::query(...)` so no .sqlx cache delta expected.
- `cd src-tauri && cargo nextest run` — full suite passes against the rebuilt blocks table; the 4 new `cache::page_id::tests::*` pass.
- The audit-predicate `SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND page_id != id` returns 0 on the migrated test DB.
- pre-commit + pre-push hooks will run on commit/push (cargo fmt + clippy + nextest + migrations-immutable + migrations-strict-required).

**Process notes:** Read-only audit subagent (Explore type) produced the inventory of `blocks` columns, indexes, triggers, FK referrers, and schema-introspection sites before writing the migration — necessary because the table has accreted 12 columns across 5 ALTER-equivalent migrations (0001/0012/0013/0024/0027) and 2 drop-column migrations (0018/0058/0060), and the new `_new_blocks` had to match the exact current shape plus the CHECK so existing `sqlx::query_as!(BlockRow, ...)` bindings (which key on column index) continue to work without modification.

**Lessons learned (for future sessions):** When rebuilding a heavily-FK-referenced table, the SQLite docs recommend `PRAGMA foreign_keys = OFF` before the rebuild — but sqlx wraps every migration in a transaction and the pragma is a no-op inside a tx, so the path forward is to keep FKs ON and rely on commit-time validation. This works because (a) no row references a missing block id at the start of the migration, (b) the rebuild copies rows verbatim (`INSERT INTO _new_blocks SELECT * FROM blocks`), so referencing FK rows continue to point at valid ids throughout. The audit step was load-bearing — without it, several columns or indexes would have been silently missed.

**Commit plan:** single commit on branch `refactor/blocks-check-page-id-invariant-111`; PR against `main`. Closes #111.
