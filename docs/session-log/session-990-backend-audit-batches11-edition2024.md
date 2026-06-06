# Session 990 — Backend Audit: Batch 11 + Rust Edition 2024 Upgrade

**Date:** 2026-06-06
**Branch(es):** `fix/backend-audit-batch11` (PR #527), `fix/rust-edition-2024` (in progress)

## What shipped

### Batch 11 — PR #527

Issues: #478 #487

- **#478** `gcal_push/api.rs` — remove dead `GcalApi::get_event` method and its 2 unit tests; update module-level doc to remove "get" bullet
- **#478** `gcal_push/connector.rs` — call `lease::release_lease` best-effort after `run_task_loop` exits on shutdown; errors logged at warn
- **#478** `commands/gcal.rs` — replace inline `parse::<i64>().unwrap_or(DEFAULT_WINDOW_DAYS)` with `parse_window_days`; make `parse_window_days` `pub(crate)` in `connector.rs`
- **#487** `block_positions.rs` + `block_descendants/proptest_b4.rs` — delete dead module and proptest (`next_sibling_position_excluding_sentinel` has no production callers; recurrence uses fractional indexing since M-78)
- **#487** `import.rs:180` — fix misleading comment ("at or above this depth" → "immediately preceding block, Logseq property-line convention")
- **#487** `maintenance.rs` — fix retry behavior: `last_run` only advanced on `Ok`, not `Err` (was silently burning full interval on failure); fix module doc; add pinning test `run_tick_does_not_advance_last_run_on_failure`
- **#487** `maintenance.rs:tombstone_purge` — document per-run cap (1000 rows/24h ceiling)
- **#487** `spaces/bootstrap.rs` — batch `migrate_orphan_tags_to_space` N+1 → single `json_each + ROW_NUMBER() OVER (PARTITION BY tag_id)` bulk query

### In-progress: Rust Edition 2024 Upgrade (PR pending)

Issue: #459

- `cargo fix --edition --all-targets` applied mechanical 2021→2024 migrations
- `edition = "2024"` flipped in `src-tauri/Cargo.toml`
- `cargo fmt` reformatted ~124 files to edition-2024 style
- Tests running; rebase onto current main (batches 7-11 merged) pending

## Infrastructure / reconciliation

- **PR #523** (batch 7): already merged ✓
- **PR #524** (batch 8): already merged ✓
- **PR #525** (batch 9): DCO failure + missing `.sqlx` entries fixed; rebased + force-pushed; merged ✓
- **PR #526** (batch 10): merged ✓
- **PR #527** (batch 11): CI running (only `build` pending)

## Batch 12 — PR #529

Issues: #460 #462 #464

Branch: `fix/backend-audit-batch12` (based off `fix/rust-edition-2024`)

- **#460** `cache/page_id.rs` + `materializer/` — new `SetBlockPageId` task; `create_block` enqueues O(1) per-block incremental update instead of O(N) full `RebuildPageIds`. Skipped for page blocks — their `page_id = id` is enforced by `page_id_self_for_pages` CHECK at INSERT time. Bug found and fixed: the original dispatch fired `SetBlockPageId` for page blocks too, causing a CHECK constraint violation (NULL parent → NULL page_id on page rows).
- **#462** `gcal_push/connector.rs` + `lib.rs` — thread `OAuthClient` into `run_task_loop`; proactively refresh access token when expiring within 120s before calling `run_cycle`
- **#464** `mcp/rmcp_adapter.rs` — rename `SpikeMockRegistry` → `MockRoRegistry`, clean stale "spike" comments in tests

## Shipped

### Edition 2024 — PR #528

Issue: #459

- `edition = "2024"` in Cargo.toml; all mechanical `cargo fix --edition --all-targets` migrations applied
- `cargo fmt --all` for edition-2024 import/expression style
- `cargo clippy --fix` for 63 `collapsible_if` lints now fixable via stable `let_chains` (Rust 1.86+)
- 8 cast/iterator lint fixes in test code (`try_from`, `rfind`)
- `disable_webkit_dmabuf_if_unset()` helper with `#[allow(unsafe_code)]` + SAFETY comment
