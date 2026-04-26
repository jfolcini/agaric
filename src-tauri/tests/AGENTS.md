# Rust Backend Test Infrastructure

## Overview

Three test layers, 2000+ tests total:

| Layer | Location | What it tests |
|-------|----------|---------------|
| **Unit** | `src/<module>.rs` → `mod tests` (or `src/<module>/tests.rs`) | Single-module logic: serde, hashing, pagination math, error formatting |
| **Integration** | `src/integration_tests.rs`, `src/command_integration_tests/`, `src/sync_integration_tests.rs` | Cross-module pipelines through the full command stack |
| **Benchmarks** | `benches/*.rs` | Criterion microbenchmarks (24 bench files, never in CI) |

Additionally: `src/lib.rs` contains `specta_tests` for TypeScript binding verification.

## Running Tests

> **Package name vs lib target:** the cargo **package** is named `agaric`
> (per `Cargo.toml` `[package].name`), the **lib target** is named
> `agaric_lib` (per `[lib].name`). Use `-p agaric` (or `package(agaric)` in
> nextest filter expressions) — `-p agaric-lib` and `package(agaric-lib)`
> are NOT valid and will error with `package ID specification ... did not
> match any packages`. The `agaric_lib` token only appears as a Rust
> import path (`use agaric_lib::...`) inside benches / integration tests.

```bash
# Source cargo env first (required on this machine)
. "$HOME/.cargo/env"

# All tests via nextest (preferred — parallel, retries)
cd src-tauri && cargo nextest run

# All tests via cargo test (includes doctests, which nextest skips)
cd src-tauri && cargo test

# Specific test by name substring
cargo nextest run -p agaric create_block_returns
cargo test -p agaric -- create_block_returns

# All tests in one module
cargo nextest run -p agaric -E 'test(::op_log::)'
cargo test -p agaric -- op_log::tests

# Only integration tests
cargo test -p agaric -- integration_tests
cargo test -p agaric -- command_integration_tests
cargo test -p agaric -- sync_integration_tests

# Snapshot review after changes
cargo insta test          # run tests, save pending snapshots
cargo insta review        # interactive accept/reject

# Regenerate TypeScript bindings (ignored by default)
cargo test -p agaric -- specta_tests --ignored

# Benchmarks (local only, never CI)
cargo bench --bench hash_bench
cargo bench               # all 24 benches
```

## Nextest Configuration

`.config/nextest.toml`:
- `fail-fast = false` — always runs all tests even if some fail
- `retries = 1` (default profile), `retries = 2` (CI profile)
- `slow-timeout = 30s` (default), `60s` (CI) — DB-backed tests can be slow on cold cache

## Test Organization

### Inline unit tests (every module)

Every `src/<module>.rs` has a `#[cfg(test)] mod tests` block (or a separate `src/<module>/tests.rs` file included via `mod tests` in `mod.rs` for larger modules like `backlink`, `cache`). Modules with tests include:
`backlink`, `cache`, `commands`, `dag`, `db`, `device`, `draft`, `error`, `fts`, `hash`, `import`, `materializer`, `merge`, `op`, `op_log`, `pagination`, `pairing`, `peer_refs`, `recovery`, `recurrence`, `reverse`, `snapshot`, `soft_delete`, `sync_cert`, `sync_daemon`, `sync_events`, `sync_files`, `sync_net`, `sync_protocol`, `sync_scheduler`, `tag_inheritance`, `tag_query`, `ulid`, `word_diff`.

### Cross-module integration tests

- **`src/integration_tests.rs`** — End-to-end pipelines: create → op log → materializer → cache → pagination → soft-delete → restore → purge. Seven test groups: op ordering/hash chains, crash recovery, cascade delete/purge, pagination, position handling, materializer dispatch, edit sequences.
- **`src/command_integration_tests/`** (module directory with ~11 files: `block_integration.rs`, `page_integration.rs`, `tag_integration.rs`, `property_integration.rs`, `backlink_integration.rs`, `lifecycle_integration.rs`, `sync_integration.rs`, `trash_integration.rs`, `undo_integration.rs`, plus `common.rs` + `mod.rs`) — API contract tests for every `*_inner` command function. Happy paths, error variants, edge cases, cross-cutting lifecycle. Tests every Tauri command as if calling from the frontend.
- **`src/sync_integration_tests.rs`** — Sync protocol integration tests: message serialization, peer handling, conflict resolution.

All three are `#[cfg(test)] mod` includes in `lib.rs` — they compile as part of the lib crate's test binary, not as separate test binaries.

### Benchmarks

24 Criterion bench files in `benches/`:
`agenda_bench`, `alias_bench`, `attachment_bench`, `backlink_query_bench`, `cache_bench`, `commands_bench`, `compaction_bench`, `draft_bench`, `export_bench`, `fts_bench`, `graph_bench`, `hash_bench`, `import_bench`, `merge_bench`, `move_reorder_bench`, `op_log_bench`, `pagination_bench`, `property_bench`, `property_def_bench`, `snapshot_bench`, `soft_delete_bench`, `sync_bench`, `tag_query_bench`, `undo_redo`

All declared with `harness = false` in `Cargo.toml`.

## Writing Unit Tests

### Database setup pattern

Every DB-backed test follows this exact pattern — a `test_pool()` helper in each module:

```rust
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}
```

**Critical:** The `TempDir` must be returned and held in `_dir` — dropping it deletes the temp directory and the SQLite file. Pattern: `let (pool, _dir) = test_pool().await;`

For tests needing separate read/write pools (only in `db.rs`):
```rust
async fn test_pools() -> (DbPools, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pools = init_pools(&db_path).await.unwrap();
    (pools, dir)
}
```

### Async test attribute

DB-backed tests use `#[tokio::test]`. Tests that need the materializer (background tasks) require multi-thread:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
```

Pure-logic tests (serde, hashing, parsing) use plain `#[test]`.

### Naming conventions

- Functions: `test_name_describes_behavior` — no `test_` prefix. Names read as assertions: `create_block_returns_correct_fields`, `edit_deleted_block_returns_not_found`, `hash_chain_links_each_op_to_its_predecessor`.
- Snapshot tests: `snapshot_<what>` — e.g., `snapshot_create_block_response`, `snapshot_op_record_after_create_block`.
- Fixture constants: `DEV`, `FIXED_TS`, `PAST_TS`, `FAR_FUTURE_TS`, `FAKE_HASH`, `TYPE_CONTENT`, etc. — module-local, not shared across modules.

### Helper functions

Each test module defines its own helpers. Common patterns:

```rust
// Direct DB insert bypassing command layer
async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str, ...) { ... }

// Build minimal payload for a specific op type
fn make_create_payload(block_id: &str) -> OpPayload { ... }

// Shorthand for the most common create operation
async fn create_content(pool: &SqlitePool, mat: &Materializer, content: &str, ...) -> BlockResponse { ... }
```

### Materializer settle pattern

After operations that trigger background cache-rebuild tasks (edit, delete, restore, purge, create page/tag), insert a 50ms sleep:

```rust
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}
```

**Not needed** after creating "content" blocks (no background tasks dispatched). Required to prevent SQLite write-lock contention between the materializer's background consumer and the next test write.

### Block-count cache sync primitives

`Materializer` exposes two `pub async` helpers that gate on the cached
block-count state used by the adaptive FTS-optimize threshold. They
cover disjoint concerns — do not confuse them:

| Helper | Gates on | Call shape | Use when… |
|--------|----------|------------|-----------|
| `wait_for_initial_block_count_cache` | The **one-shot** background task spawned inside `Materializer::build` that populates `cached_block_count` from the current DB state at startup. | Set-once boolean flag + `Notify`. Idempotent — later calls fast-return. | The test wants to overwrite `cached_block_count` with a simulated value (e.g. to exercise the adaptive threshold at 10 M-block scale). Must be called before the `.store(…)` or the startup refresh can clobber the simulated value. See the `wait_for_initial_block_count_cache_*` tests in `materializer::tests` for canonical usage. |
| `wait_for_pending_block_count_refreshes` | **All currently in-flight** `refresh_block_count_cache()` tasks (counted, repeatable). Today these are spawned only after an FTS optimize in `dispatch.rs`, but any future fire-and-forget site using the same helper is automatically covered. | `AtomicU32` counter + `Notify` + RAII `PendingRefreshGuard`. Waiter uses a double-checked pattern so late-attachers observe the zero counter on the fast path. Fast-returns when nothing is pending. | The test triggers an FTS optimize (or otherwise invokes a post-optimize refresh) and then wants to simulate a different `cached_block_count`. Without this helper the late-arriving refresh can clobber the simulated value between the `.store(…)` and the assertion. |

The two helpers **compose**. Tests that walk both paths — initial
refresh plus a post-optimize refresh — typically call the first once at
the top of the test, run the work that triggers the post-optimize
refreshes, then call the second before simulating / asserting. Either
helper remains independently useful: a test that only exercises one
path calls only one helper.

Neither helper is `#[cfg(test)]`-gated (both are plain `pub`) — they
remain available to integration tests in sibling modules / crates.
Production code never needs to call either; the gate fields are two
`Arc` pointers per `Materializer` and cost nothing at runtime.

### Error testing

Error paths use `matches!` on `AppError` variants:

```rust
let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;
assert!(
    matches!(result, Err(AppError::NotFound(_))),
    "editing nonexistent block must return AppError::NotFound"
);
```

For checking error messages:
```rust
let err = result.unwrap_err();
assert!(err.to_string().contains("unknown block_type"));
```

### Assertion style

- `assert_eq!` with descriptive message for value comparisons
- `assert!(matches!(...))` for enum variant checks
- `assert!(result.is_err())` / `assert!(result.is_ok())` for Result checks
- `insta::assert_yaml_snapshot!` for complex response structures (see Snapshot Testing below)
- **Prefer exact counts** — use `assert_eq!(count, 5)` not `assert!(count >= 1)`. Inequality assertions hide subtle bugs like duplicate results or missing filters.

## Writing Integration Tests

### `integration_tests.rs` — Pipeline tests

Tests complete flows across multiple modules. Seven groups:
1. Op ordering & hash chains
2. Crash recovery simulation
3. Cascade delete & purge
4. Pagination
5. Position handling
6. Materializer background dispatch
7. Edit sequences

**When to add here:** When testing a behavior that spans 3+ modules or requires verifying end-to-end state consistency (e.g., "create → edit → delete → restore produces correct op chain with valid hashes").

Uses `create_content()` shorthand and `settle_bg_tasks()` between materializer-triggering operations.

### `command_integration_tests/` — API contract tests

Tests every `*_inner` function's contract: inputs, outputs, error variants.
Organized by command across the 11 files in the
`src/command_integration_tests/` module directory (create_block, edit_block,
delete_block, restore_block, purge_block, move_block, list_blocks,
get_block, add_tag, remove_tag, search_blocks, query_by_tags, properties,
etc.).

**When to add here:** When adding a new Tauri command or changing an existing command's behavior. Every command gets:
- Happy path (correct fields returned, DB persistence verified)
- Error paths (nonexistent ID → NotFound, deleted block → NotFound, invalid input → Validation)
- Edge cases (empty content, unicode, large payloads, rapid concurrent creates)
- Op log verification (correct op_type logged, correct payload)

### `sync_integration_tests.rs` — Sync protocol tests

Tests sync message serialization, peer communication flows, and conflict resolution. Covers all `SyncMessage` variants, wire format stability, and edge cases (unicode, large batches, boundary values).

**When to add here:** When changing sync protocol messages, peer handling, or conflict resolution logic.

### Key difference

| Aspect | `integration_tests.rs` | `command_integration_tests/` | `sync_integration_tests.rs` |
|--------|----------------------|-------------------------------|---------------------------|
| Focus | Cross-module pipelines | Single command API contracts | Sync protocol flows |
| Scope | End-to-end state flows | Command boundary behavior | Peer-to-peer data exchange |
| When to add | New multi-module interaction | New/changed Tauri command | Sync message/protocol changes |

### Undo/reverse testing

`reverse.rs` tests verify inverse op computation. Key patterns:
- Test the reverse of each op type (see ARCHITECTURE.md § Undo/Redo for the full table)
- **Batch grouping:** consecutive ops within 200ms by the same device are grouped — backend's `revert_ops` sorts newest-first (`created_at DESC, seq DESC`) before applying. Tests must verify this ordering.
- Non-reversible ops (`purge_block`, `delete_attachment`) must return `AppError::NonReversible`, not panic
- Prior-state lookups use the op log exclusively (not the materialized `blocks` table), so tests must verify correct op-log walking even when the materializer lags
- Reverse ops are **appended** to the op log (log remains append-only) — never assert that existing ops were mutated
- Test helpers: `append_op()` with `append_local_op_at` for deterministic timestamps, `FIXED_TS` / `TEST_DEVICE` fixture constants

## Snapshot Testing (insta)

### Where snapshots live

Insta `.snap` files live alongside the code they test. Six directories
currently hold snapshots:

- **`src/snapshots/`** — snapshots for modules whose tests are inline in
  `src/<module>.rs` (`op`, `op_log`, plus a small set of `pagination`
  historical snapshots — see TEST-37 for the three duplicated files
  staged for deletion).
- **`src/backlink/snapshots/`** — `backlink` module tests.
- **`src/commands/tests/snapshots/`** — `commands` submodule tests
  (BlockResponse, DeleteResponse, PageResponse, StatusInfo, HistoryEntry).
- **`src/pagination/snapshots/`** — current `pagination::tests` snapshots.
- **`src/mcp/snapshots/`** — MCP (Model Context Protocol) tool / response
  snapshots (~11 files).
- **`src/gcal_push/snapshots/`** — Google Calendar push payload / response
  snapshots (~6 files).

Naming: `agaric_lib__<module>__tests__<test_name>.snap`. If you add a new
snapshot-testing module, create a sibling `snapshots/` directory next to
the module file rather than piling into `src/snapshots/`.

### Modules using snapshots

- **`backlink`** — snapshot tests for backlink query results
- **`commands`** — BlockResponse, DeleteResponse, PageResponse, StatusInfo, HistoryEntry
- **`op`** — JSON serialization of all 12 OpPayload variants
- **`op_log`** — OpRecord after append, get_ops_since results
- **`pagination`** — PageResponse structures, HistoryEntry

### Redaction patterns

Non-deterministic fields are redacted with placeholder strings:

```rust
// Single field redaction
insta::assert_yaml_snapshot!(resp, {
    ".id" => "[ULID]",
});

// Timestamp redaction
insta::assert_yaml_snapshot!(resp, {
    ".deleted_at" => "[TIMESTAMP]",
});

// Hash redaction
insta::assert_yaml_snapshot!(record, {
    ".hash" => "[HASH]",
});

// Array element redaction
insta::assert_yaml_snapshot!(ops, {
    "[].hash" => "[HASH]",
});

// Cursor redaction
insta::assert_yaml_snapshot!(resp, {
    ".next_cursor" => "[CURSOR]",
});
```

### For deterministic data, no redaction needed

```rust
// insert_block with known IDs → fully deterministic snapshot
insert_block(&pool, "SNAP_BLK1", "content", "first", None, Some(1)).await;
let resp = list_blocks_inner(&pool, ...).await.unwrap();
insta::assert_yaml_snapshot!(resp);  // no redaction needed
```

### Named snapshots (for loops)

```rust
for payload in all_test_payloads() {
    let tag = payload.op_type_str();
    let json: serde_json::Value = serde_json::to_value(&payload).unwrap();
    insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), json);
}
```

### Workflow

```bash
# Run tests — failing snapshots create .snap.new files
cargo insta test

# Review pending changes interactively
cargo insta review

# Accept all pending snapshots (use with care)
cargo insta test --review
```

## Benchmarks (Criterion)

### When to write

Add benchmarks for hot-path functions that run on every user action (create, edit, list, search). Current coverage (24 bench files):

| Bench file | What it benchmarks | Parameterized scales |
|------------|--------------------|---------------------|
| `agenda_bench` | count_agenda_batch, count_agenda_batch_by_source, list_projected_agenda | 100/1K/10K |
| `alias_bench` | set/get/resolve aliases | — |
| `attachment_bench` | add/delete/list attachments | — |
| `backlink_query_bench` | count_backlinks_batch, list_unlinked_references | — |
| `cache_bench` | cache rebuild operations | — |
| `commands_bench` | create_block, edit_block, list_blocks, get_block, get_block_history, get_conflicts | varying sizes |
| `compaction_bench` | get_compaction_status, compact_op_log | 1K/10K/100K ops |
| `draft_bench` | delete_draft, list_drafts | — |
| `export_bench` | export_page_markdown | 100/500/2000 blocks |
| `fts_bench` | search_fts, rebuild_fts_index, update_fts_for_block, fts_optimize | 1K/10K/100K blocks |
| `graph_bench` | list_page_links | 100/1K/10K pages |
| `hash_bench` | compute_op_hash, verify_op_hash | varying payload sizes |
| `import_bench` | import_markdown | — |
| `merge_bench` | merge operations | — |
| `move_reorder_bench` | move_block, reorder | — |
| `op_log_bench` | append operations | — |
| `pagination_bench` | pagination queries | — |
| `property_bench` | set/get/delete property, set_todo_state, set_priority, set_due_date, set_scheduled_date | 100/1K/10K |
| `property_def_bench` | create/list/update/delete property defs | — |
| `snapshot_bench` | snapshot operations | — |
| `soft_delete_bench` | soft delete operations | — |
| `sync_bench` | list/delete/update/set peer refs | — |
| `tag_query_bench` | list_tags_by_prefix, list_tags_for_block | — |
| `undo_redo` | restore_page_to_op, redo_page_op, compute_edit_diff | — |

### Pattern

```rust
use criterion::{criterion_group, criterion_main, Criterion};
use tokio::runtime::Runtime;

fn bench_foo(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "bench_name"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    c.bench_function("descriptive_name", |b| {
        b.to_async(&rt).iter(|| {
            // async bench body
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

criterion_group!(benches, bench_foo, ...);
criterion_main!(benches);
```

### Rules

- **Never run in CI or pre-commit.** Manual only: `cargo bench`
- Each bench creates its own temp DB with `TempDir`
- Shut down materializer after each bench group
- Use parameterized groups (`BenchmarkId::from_parameter`) for size comparisons (e.g., 100/1K/10K)
- Verify new benches compile with `cargo check --bench <name>` before committing

## Quality Standards

1. **Isolation** — Every test gets its own `TempDir` + SQLite database. No shared state. No test ordering dependencies.
2. **Determinism** — Use `FIXED_TS` constants instead of `now()` where possible. Redact non-deterministic fields (ULIDs, timestamps, hashes) in snapshots. Use `append_local_op_at` (caller-provided timestamp) instead of `append_local_op` (wall-clock) when timestamp must be stable.
3. **No timing-dependent assertions** — The `settle()` / `settle_bg_tasks()` sleep is for write-lock contention avoidance, not for asserting timing. Materializer metrics tests use generous windows (200ms).
4. **Descriptive assertion messages** — Every `assert!` includes a message string explaining expected behavior.
5. **Error path coverage** — Every command tests at minimum: nonexistent ID (→ NotFound), deleted block (→ NotFound), invalid input (→ Validation).
6. **Op log verification** — After state-changing operations, verify op_log entries: count, op_type, payload contents, hash integrity.
7. **Exact count assertions** — Prefer `assert_eq!(count, 5)` over `assert!(count >= 1)`. Inequality assertions (`>=`, `>`) hide subtle bugs like duplicate results, missing filter application, or extra rows from conflict copies. When a review catches `>=` in a test, replace it with `assert_eq!`.
8. **Zero flaky tests** — Flaky tests are bugs. Tests must pass 100% of the time with `--retries 0`. Common causes and fixes:
   - **Timestamp collisions** — `now_rfc3339()` has millisecond precision. Two calls in the same ms produce identical timestamps. If a test asserts `t1 != t2` on consecutive operations, insert `tokio::time::sleep(Duration::from_millis(2)).await` between them. Better: use `FIXED_TS` constants when the test doesn't need real wall-clock time.
   - **Materializer races** — Background tasks can race with the next test write. Always call `settle()` / `settle_bg_tasks()` / `mat.flush_background()` between materializer-triggering operations. Never assert on queue depth without a flush barrier.
   - **Non-deterministic ordering** — `FxHashSet` iteration order is not stable. Use `BTreeSet` or sort results before comparing. Collect into `HashSet` and use `assert!(set.contains(...))` instead of `assert_eq!(vec[0], ...)`.

## Common Pitfalls

1. **Forgetting `_dir`** — `let (pool, _dir) = test_pool().await;` — if you write `let (pool, _) = ...`, the `TempDir` drops immediately and the SQLite file is deleted. Tests will fail with cryptic DB errors.

2. **Missing `settle()` before the next write** — After `delete_block_inner`, `edit_block_inner`, `restore_block_inner`, `purge_block_inner`, or creating page/tag blocks, you must call `settle().await` (50ms) before the next DB write. Otherwise the materializer's background cache-rebuild transaction contends with the next `BEGIN IMMEDIATE`.

3. **Wrong tokio test flavor** — Tests using `Materializer` require `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Using the default single-threaded executor will deadlock because materializer background tasks can't progress.

4. **Snapshot test with non-deterministic data** — If you snapshot a response containing ULIDs, timestamps, or hashes without redaction, the snapshot will break on every run. Always redact: `.id => "[ULID]"`, `.hash => "[HASH]"`, etc.

5. **`cargo sqlx prepare` after SQL changes** — The project uses compile-time checked SQL queries (`query!` macros). Changing SQL in source requires regenerating the offline cache: `cargo sqlx prepare -- --tests`. Tests will fail to compile otherwise.

6. **Specta bindings drift** — If you change Rust types used in Tauri commands, the `ts_bindings_up_to_date` test will fail. Regenerate: `cargo test -p agaric -- specta_tests --ignored`.

7. **Integration test files are `mod` includes, not separate binaries** — `integration_tests.rs`, the `command_integration_tests/` module directory (11 files), and `sync_integration_tests.rs` are `#[cfg(test)] mod` in `lib.rs`. They share the same test binary as unit tests.

8. **Test helper duplication is intentional** — Each module defines its own `test_pool()`, `insert_block()`, etc. This is by design: tests are self-contained, no shared test utility crate.

9. **Timestamp assertions need a sleep guard** — `now_rfc3339()` has millisecond precision. If a test needs two distinct timestamps from consecutive operations, add `tokio::time::sleep(Duration::from_millis(2)).await` between them. Never write `assert_ne!(t1, t2)` on consecutive wall-clock timestamps without a sleep guard.

10. **CTE queries must filter `is_conflict = 0`** — Recursive CTEs for descendant walks (list children, cascade operations, tree queries) must include `AND is_conflict = 0` in the recursive member. Without it, conflict copies leak into results as phantom extra blocks. This was caught during review before shipping — symptoms are subtle (extra items in list responses, wrong counts).

11. **Multi-op sequences need transaction wrapping** — When a feature requires multiple ops atomically (e.g., create block + set property for recurrence), use `_in_tx` function variants or wrap in a `BEGIN IMMEDIATE` transaction. Without this, a crash between ops leaves inconsistent state. Tests should verify all-or-nothing: if the second op fails, the first must be rolled back.

12. **Avoid silent error swallowing in new code** — `.ok()`, `.unwrap_or_default()` are acceptable for non-critical enrichment (e.g., tag name resolution in FTS), but not on core data paths. When adding error handling, prefer `tracing::warn!` + explicit fallback over silent discard. Tests should verify that error paths on core operations actually propagate errors. The `.expect("…poisoned")` pattern on mutexes should be `.unwrap_or_else(|e| e.into_inner())` instead.

13. **Position values are 1-based** — Block positions among siblings start at 1, not 0. Passing `position: 0` to `move_block` hits a validation error. All position fixtures must use values `>= 1`.

14. **ULID normalization in hash tests** — ULIDs are uppercase Crockford base32 before blake3 hashing (for cross-device determinism). Hardcoded test ULIDs must be uppercase (`"01HZ..."` not `"01hz..."`). Lowercase ULIDs produce different hashes and will break hash-chain assertions.

15. **Visibility changes for benchmarks** — Bench files are separate crates and can only access `pub` items. When adding benchmarks for `*_inner` command functions, you may need to widen visibility from `pub(crate)` to `pub`. This is acceptable for `*_inner` functions that are the testable entry points.

16. **Recursive CTE tests must verify nested structures** — When testing tree operations (restore, cascade delete, move), verify that nested blocks are discovered. A flat page-scoped query (`WHERE parent_id = ?`) misses grandchildren — use a recursive CTE with `AND is_conflict = 0` and `depth < 100` bounds.

17. **Sentinel values need dedicated test branches** — Special values like `__all__` for `page_id` mean "global scope" and require different SQL (no CTE). Tests must cover both specific-page and sentinel paths.

18. **Adding command parameters breaks integration tests mechanically** — When adding new parameters to `*_inner` functions, ALL call sites in the integration test files must be updated. This is purely mechanical (adding the new param at every call site) but can touch 30+ locations. The compiler catches all of them.

19. **Materializer error propagation** — Materializer tasks (`ApplyOp`, `BatchApplyOps`) must propagate errors for retry, not swallow them with `.ok()`. Silently dropping errors prevents retry on transient failures. Tests should verify that materializer task errors bubble up.

20. **Batch INSERT via multi-row VALUES for performance** — When inserting many rows (e.g., `apply_snapshot`), use chunked multi-row `INSERT INTO ... VALUES (?,?,...), (?,?,...), ...` with a `MAX_SQL_PARAMS` constant. SQLite has a parameter limit (~999), so chunk sizes must account for columns-per-row (e.g., blocks=83, tags=499, props=166, links=499, attachments=124 rows per chunk).

21. **`is_builtin_property_key()` guards on delete** — Built-in property keys (11: `todo_state`, `priority`, `due_date`, `scheduled_date`, `created_at`, `completed_at`, `repeat`, `repeat-until`, `repeat-count`, `repeat-seq`, `repeat-origin`) cannot be deleted by users. `delete_property_inner` validates against `is_builtin_property_key()` and returns `Validation`. Tests must verify this guard rejects built-in keys.

22. **`total_count` must use post-filter count** — When a query filters results after the initial fetch (e.g., self-reference filtering in backlinks), `total_count` must be set from the filtered length, not the pre-filter length. Otherwise pagination reports inflated totals.

23. **Purge must clean all tables with FK to `blocks`** — When adding a new table referencing `blocks`, add a cleanup step in `purge_block_inner` (cascade queries in `commands/blocks/crud.rs`) AND in the materializer's `PurgeBlock` handler. Add a test case verifying rows are deleted. Current cleanup covers all known tables including `page_aliases` and `projected_agenda_cache`.

24. **Snapshot restore enqueues cache rebuild tasks** — `apply_snapshot()` in `src/snapshot/restore.rs` deletes `tags_cache`, `pages_cache`, `agenda_cache`, `projected_agenda_cache`, `block_tag_inherited`, `fts_blocks`, then inserts snapshot data and enqueues the full cache-rebuild set (`RebuildTagsCache`, `RebuildPagesCache`, `RebuildAgendaCache`, `RebuildProjectedAgendaCache`, `RebuildTagInheritanceCache`, `RebuildPageIds`, `RebuildFtsIndex`) on the materializer before returning. The function signature is `apply_snapshot(pool, materializer, compressed_data)`. Tests that want to assert on cache state post-restore must call `materializer.flush_background().await` first to let the rebuild tasks run. (Fixed in BUG-42.)
