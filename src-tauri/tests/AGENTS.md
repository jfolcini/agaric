# Rust Backend Test Infrastructure

## Overview

Four test layers, ~850+ tests total:

| Layer | Location | What it tests |
|-------|----------|---------------|
| **Unit** | `src/<module>.rs` → `mod tests` | Single-module logic: serde, hashing, pagination math, error formatting |
| **Integration** | `src/integration_tests.rs`, `src/command_integration_tests.rs` | Cross-module pipelines through the full command stack |
| **Serializer** | `tests/serializer_tests.rs` | Org-mode parser/emitter round-trips (separate binary, no DB) |
| **Benchmarks** | `benches/*.rs` | Criterion microbenchmarks (7 bench files, never in CI) |

Additionally: `src/lib.rs` contains `specta_tests` for TypeScript binding verification.

## Running Tests

```bash
# Source cargo env first (required on this machine)
. "$HOME/.cargo/env"

# All tests via nextest (preferred — parallel, retries)
cd src-tauri && cargo nextest run

# All tests via cargo test (includes doctests, which nextest skips)
cd src-tauri && cargo test

# Specific test by name substring
cargo nextest run -p block-notes-lib create_block_returns
cargo test -p block-notes-lib -- create_block_returns

# All tests in one module
cargo nextest run -p block-notes-lib -E 'test(::op_log::)'
cargo test -p block-notes-lib -- op_log::tests

# Only integration tests
cargo test -p block-notes-lib -- integration_tests
cargo test -p block-notes-lib -- command_integration_tests

# Only the serializer test binary
cargo test --test serializer_tests

# Snapshot review after changes
cargo insta test          # run tests, save pending snapshots
cargo insta review        # interactive accept/reject

# Regenerate TypeScript bindings (ignored by default)
cargo test -p block-notes-lib -- specta_tests --ignored

# Benchmarks (local only, never CI)
cargo bench --bench hash_bench
cargo bench               # all 7 benches
```

## Nextest Configuration

`.config/nextest.toml`:
- `fail-fast = false` — always runs all tests even if some fail
- `retries = 1` (default profile), `retries = 2` (CI profile)
- `slow-timeout = 30s` (default), `60s` (CI) — DB-backed tests can be slow on cold cache

## Test Organization

### Inline unit tests (every module)

Every `src/<module>.rs` has a `#[cfg(test)] mod tests` block. Modules with inline tests:
`cache`, `commands`, `dag`, `db`, `device`, `draft`, `error`, `fts`, `hash`, `materializer`, `merge`, `op`, `op_log`, `org_emitter`, `org_parser`, `pagination`, `recovery`, `serializer`, `snapshot`, `soft_delete`, `tag_query`, `ulid`

### Cross-module integration tests

- **`src/integration_tests.rs`** — End-to-end pipelines: create → op log → materializer → cache → pagination → soft-delete → restore → purge. Seven test groups: op ordering/hash chains, crash recovery, cascade delete/purge, pagination, position handling, materializer dispatch, edit sequences.
- **`src/command_integration_tests.rs`** — API contract tests for every `*_inner` command function. Happy paths, error variants, edge cases, cross-cutting lifecycle (2700+ lines). Tests every Tauri command as if calling from the frontend.

Both files are `#[cfg(test)] mod` includes in `lib.rs` — they compile as part of the lib crate's test binary, not as separate test binaries.

### External test binary

- **`tests/serializer_tests.rs`** — Separate integration test binary. Tests org-mode parser, emitter, round-trips, unicode edge cases, entity tables, config. No database needed. Pure `#[test]` (sync, no tokio).

### Benchmarks

Seven Criterion bench files in `benches/`:
`cache_bench`, `commands_bench`, `fts_bench`, `hash_bench`, `op_log_bench`, `pagination_bench`, `soft_delete_bench`

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

### `command_integration_tests.rs` — API contract tests

Tests every `*_inner` function's contract: inputs, outputs, error variants. Organized by command (create_block, edit_block, delete_block, restore_block, purge_block, move_block, list_blocks, get_block, add_tag, remove_tag, search_blocks, query_by_tags, properties, etc.).

**When to add here:** When adding a new Tauri command or changing an existing command's behavior. Every command gets:
- Happy path (correct fields returned, DB persistence verified)
- Error paths (nonexistent ID → NotFound, deleted block → NotFound, invalid input → Validation)
- Edge cases (empty content, unicode, large payloads, rapid concurrent creates)
- Op log verification (correct op_type logged, correct payload)

### Key difference

| Aspect | `integration_tests.rs` | `command_integration_tests.rs` |
|--------|----------------------|-------------------------------|
| Focus | Cross-module pipelines | Single command API contracts |
| Scope | End-to-end state flows | Command boundary behavior |
| When to add | New multi-module interaction | New/changed Tauri command |

## Snapshot Testing (insta)

### Where snapshots live

`src/snapshots/` — 22 `.snap` files. Naming: `block_notes_lib__<module>__tests__<test_name>.snap`.

### Modules using snapshots

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

Add benchmarks for hot-path functions that run on every user action (create, edit, list, search). Current coverage:
- `commands_bench` — create_block, edit_block, list_blocks (varying sizes, pagination, filters)
- `hash_bench` — compute_op_hash, verify_op_hash (varying payload sizes)
- `op_log_bench` — append operations
- `fts_bench` — search_fts, rebuild_fts_index, update_fts_for_block, fts_optimize (1K/10K/100K blocks)
- `cache_bench`, `pagination_bench`, `soft_delete_bench`

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
- Use parameterized groups (`BenchmarkId::from_parameter`) for size comparisons

## Quality Standards

1. **Isolation** — Every test gets its own `TempDir` + SQLite database. No shared state. No test ordering dependencies.
2. **Determinism** — Use `FIXED_TS` constants instead of `now()` where possible. Redact non-deterministic fields (ULIDs, timestamps, hashes) in snapshots. Use `append_local_op_at` (caller-provided timestamp) instead of `append_local_op` (wall-clock) when timestamp must be stable.
3. **No timing-dependent assertions** — The `settle()` / `settle_bg_tasks()` sleep is for write-lock contention avoidance, not for asserting timing. Materializer metrics tests use generous windows (200ms).
4. **Descriptive assertion messages** — Every `assert!` includes a message string explaining expected behavior.
5. **Error path coverage** — Every command tests at minimum: nonexistent ID (→ NotFound), deleted block (→ NotFound), invalid input (→ Validation).
6. **Op log verification** — After state-changing operations, verify op_log entries: count, op_type, payload contents, hash integrity.

## Common Pitfalls

1. **Forgetting `_dir`** — `let (pool, _dir) = test_pool().await;` — if you write `let (pool, _) = ...`, the `TempDir` drops immediately and the SQLite file is deleted. Tests will fail with cryptic DB errors.

2. **Missing `settle()` before the next write** — After `delete_block_inner`, `edit_block_inner`, `restore_block_inner`, `purge_block_inner`, or creating page/tag blocks, you must call `settle().await` (50ms) before the next DB write. Otherwise the materializer's background cache-rebuild transaction contends with the next `BEGIN IMMEDIATE`.

3. **Wrong tokio test flavor** — Tests using `Materializer` require `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Using the default single-threaded executor will deadlock because materializer background tasks can't progress.

4. **Snapshot test with non-deterministic data** — If you snapshot a response containing ULIDs, timestamps, or hashes without redaction, the snapshot will break on every run. Always redact: `.id => "[ULID]"`, `.hash => "[HASH]"`, etc.

5. **`cargo sqlx prepare` after SQL changes** — The project uses compile-time checked SQL queries (`query!` macros). Changing SQL in source requires regenerating the offline cache: `cargo sqlx prepare -- --lib`. Tests will fail to compile otherwise.

6. **Specta bindings drift** — If you change Rust types used in Tauri commands, the `ts_bindings_up_to_date` test will fail. Regenerate: `cargo test -p block-notes-lib -- specta_tests --ignored`.

7. **Integration test files are `mod` includes, not separate binaries** — `integration_tests.rs` and `command_integration_tests.rs` are `#[cfg(test)] mod` in `lib.rs`. They share the same test binary as unit tests. The only separate test binary is `tests/serializer_tests.rs`.

8. **Test helper duplication is intentional** — Each module defines its own `test_pool()`, `insert_block()`, etc. This is by design: tests are self-contained, no shared test utility crate.
