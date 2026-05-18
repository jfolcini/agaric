# Rust backend test patterns

> See also: root [`AGENTS.md`](../../AGENTS.md) for the 9 architectural invariants tests must respect. Backend-tree-specific rules live in [`../src/commands/AGENTS.md`](../src/commands/AGENTS.md), [`../src/mcp/AGENTS.md`](../src/mcp/AGENTS.md), and [`../migrations/AGENTS.md`](../migrations/AGENTS.md).

## Test layers

| Layer | Where | What |
|---|---|---|
| Unit | `src/<module>.rs` → `#[cfg(test)] mod tests` (or `src/<module>/tests.rs`) | Single-module logic |
| Integration | `src/integration_tests.rs`, `src/command_integration_tests/`, `src/sync_integration_tests.rs` | Cross-module pipelines + command API contracts + sync protocol |
| Bench | `benches/*.rs` (24 files, `harness = false`) | Criterion microbenchmarks; manual only, never CI |

Plus `src/lib.rs` carries `specta_tests` for TypeScript binding verification.

## Running tests

> **Package vs lib target:** the cargo **package** is `agaric`; the **lib target** is `agaric_lib`. Use `-p agaric` / `package(agaric)` for filters — `-p agaric-lib` errors. `agaric_lib` only appears as a Rust import path (`use agaric_lib::…`) in benches / integration tests.

```bash
. "$HOME/.cargo/env"             # required once per shell on this machine

cargo nextest run                 # all tests (parallel, retries)
cargo test                        # all tests + doctests (nextest skips doctests)

cargo nextest run -p agaric create_block_returns           # by name substring
cargo nextest run -p agaric -E 'test(::op_log::)'          # by module

cargo test -p agaric -- integration_tests
cargo test -p agaric -- command_integration_tests
cargo test -p agaric -- sync_integration_tests

cargo insta test          # snapshot tests; writes .snap.new for changed
cargo insta review        # interactive accept/reject

cargo test -p agaric -- specta_tests --ignored   # regenerate src/lib/bindings.ts

cargo bench --bench hash_bench   # local only
```

### Nextest configuration (`.config/nextest.toml`)

- `fail-fast = false` — always runs everything even if some fail.
- `retries = 1` (default), `retries = 2` (CI profile).
- `slow-timeout = 30s` default, `60s` CI — DB-backed tests can be slow on cold cache.

## Writing unit tests

### Database setup

Every DB-backed test follows this exact pattern — a module-local `test_pool()`:

```rust
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    (pool, dir)
}
```

**Critical:** bind `_dir` so the `TempDir` outlives the pool — `let (pool, _dir) = test_pool().await`. Writing `let (pool, _) = …` drops the `TempDir` immediately and the SQLite file is deleted; tests fail with cryptic DB errors.

For tests needing separate read/write pools (only in `db.rs`): use `test_pools()` returning `(DbPools, TempDir)`.

### Async test attribute

```rust
#[tokio::test]                                                            // pure DB tests
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]               // anything using Materializer
#[test]                                                                   // pure logic (serde, hashing)
```

Materializer-touching tests REQUIRE `multi_thread` — the default single-threaded executor deadlocks because background tasks can't progress.

### Naming

- Functions read as assertions, no `test_` prefix: `create_block_returns_correct_fields`, `edit_deleted_block_returns_not_found`.
- Snapshot tests: `snapshot_<what>` — e.g. `snapshot_create_block_response`.
- Fixture constants module-local (not shared): `DEV`, `FIXED_TS`, `PAST_TS`, `FAKE_HASH`, etc.
- Helper functions module-local — each module defines its own `test_pool`, `insert_block`, `make_create_payload`. **Test helper duplication is intentional** — tests are self-contained; no shared test utility crate.

### Materializer settle

After ops that trigger background cache-rebuild (edit / delete / restore / purge / create page / create tag), insert a 50ms sleep before the next write:

```rust
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}
```

Not needed after creating "content" blocks (no background tasks dispatched). Required to prevent SQLite write-lock contention between materializer's background consumer and the next test write.

### Block-count cache sync primitives

`Materializer` exposes two `pub async` helpers. They cover disjoint concerns:

| Helper | Gates on | Use when… |
|---|---|---|
| `wait_for_initial_block_count_cache` | The one-shot startup task populating `cached_block_count`. Idempotent. | Test wants to overwrite `cached_block_count` with a simulated value (e.g. 10M-block scale). Must be called before the `.store(…)` or the startup refresh clobbers the simulated value. |
| `wait_for_pending_block_count_refreshes` | All currently in-flight `refresh_block_count_cache()` tasks. `AtomicU32` counter + `Notify`. | Test triggered an FTS optimize (which fires a refresh) and now wants to simulate a different `cached_block_count`. |

They compose: tests that exercise both paths call the first at top + the second before simulating / asserting. Neither is `#[cfg(test)]`-gated; both stay available to integration tests in sibling modules. Production code never needs to call either.

### Error testing

```rust
let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;
assert!(matches!(result, Err(AppError::NotFound(_))),
    "editing nonexistent block must return AppError::NotFound");

// For message checks (typed-error prefix protocol — see commands/AGENTS.md):
let err = result.unwrap_err();
assert!(err.to_string().contains("InvalidGlob:"));
```

### Assertion style

- `assert_eq!` with a descriptive message.
- `assert!(matches!(...))` for enum variants.
- `insta::assert_yaml_snapshot!` for complex response structures (see Snapshot Testing).
- **Exact counts only** — `assert_eq!(count, 5)` not `assert!(count >= 1)`. Inequality hides duplicate-result / missing-filter bugs.

## Writing integration tests

Three integration test surfaces, all `#[cfg(test)] mod` includes in `lib.rs` (they compile as part of the lib crate's test binary, not separate binaries):

- **`src/integration_tests.rs`** — pipeline tests spanning 3+ modules. Op chains + hash, crash recovery, cascade delete/purge, pagination, position handling, materializer dispatch, edit sequences. Use `create_content()` shorthand + `settle_bg_tasks()` between materializer-triggering ops.
- **`src/command_integration_tests/`** (11 files: block/page/tag/property/backlink/lifecycle/sync/trash/undo + `common.rs` + `mod.rs`) — every `*_inner` command's API contract. Happy path + error variants + edge cases (empty / unicode / large / concurrent) + op-log verification.
- **`src/sync_integration_tests.rs`** — sync protocol message serialisation, peer flows, conflict resolution.

**Reverse-op tests (`reverse.rs`):** test the reverse of each op type. Non-reversible ops (`purge_block`, `delete_attachment`) must return `AppError::NonReversible`, not panic. Prior-state lookups use the op log exclusively (not the materialised `blocks` table), so tests verify op-log walking even when the materializer lags. Reverse ops are **appended** to the op log — never assert existing ops were mutated. Use `append_local_op_at` with `FIXED_TS` for deterministic timestamps.

## Snapshot testing (insta)

Snapshots live alongside the code: `src/snapshots/`, `src/backlink/snapshots/`, `src/commands/tests/snapshots/`, `src/pagination/snapshots/`, `src/mcp/snapshots/`, `src/gcal_push/snapshots/`. Naming: `agaric_lib__<module>__tests__<test_name>.snap`. New snapshot-testing modules get a sibling `snapshots/` directory.

### Redaction patterns

Non-deterministic fields are redacted:

```rust
insta::assert_yaml_snapshot!(resp, {
    ".id" => "[ULID]",
    ".deleted_at" => "[TIMESTAMP]",
    ".hash" => "[HASH]",
    ".next_cursor" => "[CURSOR]",
    "[].hash" => "[HASH]",          // array element redaction
});
```

Deterministic data (`insert_block` with known IDs) needs no redaction.

### Named snapshots (for loops)

```rust
for payload in all_test_payloads() {
    let tag = payload.op_type_str();
    insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), serde_json::to_value(&payload).unwrap());
}
```

## Benchmarks (Criterion)

24 bench files cover the hot-path functions (create / edit / list / search / pagination / FTS / hash / agenda / properties / sync / undo etc.). Parameterised scales typically 100 / 1K / 10K / 100K where size matters.

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
        b.to_async(&rt).iter(|| async { /* bench body */ })
    });

    rt.block_on(async { materializer.shutdown() });
}

criterion_group!(benches, bench_foo);
criterion_main!(benches);
```

### Rules

- Never run in CI / pre-commit. Manual only.
- Each bench gets its own temp DB with `TempDir`.
- Shut down the materializer after each bench group.
- Parameterise size comparisons via `BenchmarkId::from_parameter`.
- `cargo check --bench <name>` before committing — visibility on `*_inner` may need `pub` (bench files are separate crates).

## Test file checklist

Before committing:

- DB tests bind `_dir` so `TempDir` outlives the pool.
- Async tests use `#[tokio::test]` (or `multi_thread, worker_threads = 2` for materializer).
- Materializer-triggering ops followed by `settle()` / `mat.flush_background()` before the next write.
- Names read as assertions (`x_returns_y`, not `test_x`).
- Error paths covered: nonexistent ID → `NotFound`, deleted → `NotFound`, invalid input → `Validation`.
- Snapshot tests redact `.id` / `.created_at` / `.hash` / `.next_cursor`.
- Helpers module-local (don't share across modules).
- Recursive-CTE tests verify the `is_conflict = 0` + `depth < 100` invariants from root AGENTS.md §9.
- Op-log assertions check the appended record (no mutation — append-only).
- `assert_eq!` for exact counts.
- ULID fixtures uppercase (Crockford base32 → blake3 determinism).
- Position values 1-based, not 0.
- Benchmarks declared `harness = false`, never CI.
- SQL changes: `cargo sqlx prepare -- --tests` and the `.sqlx/` updates committed.

## Quality standards

1. **Isolation.** Every test gets its own `TempDir` + DB. No shared state, no order dependencies.
2. **Determinism.** Use `FIXED_TS` over `now()` where possible. Redact non-deterministic fields in snapshots. `append_local_op_at` (caller-provided timestamp) over `append_local_op` (wall-clock) when stability matters.
3. **No timing-dependent assertions.** `settle()` is for write-lock contention avoidance, not timing. Materializer metrics tests use generous windows (200ms).
4. **Descriptive assertion messages.** Every `assert!` carries a message explaining expected behaviour.
5. **Error path coverage.** Every command tests at minimum: nonexistent ID, deleted block, invalid input.
6. **Op log verification.** State-changing operations verify op_log entries: count, op_type, payload, hash chain.
7. **Exact counts.** `assert_eq!(count, 5)`, never `assert!(count >= 1)`.
8. **Zero flaky tests.** Common causes:
   - **Timestamp collisions** — `now_rfc3339()` has millisecond precision. Two calls in the same ms produce identical timestamps. `tokio::time::sleep(Duration::from_millis(2))` between or use `FIXED_TS` constants.
   - **Materializer races** — always `settle()` / `flush_background()` between materializer-triggering ops.
   - **Non-deterministic ordering** — `FxHashSet` iteration order isn't stable. Use `BTreeSet` or sort before comparing.

## Common pitfalls

1. **Missing `_dir`** — drops `TempDir` immediately; DB file vanishes. Always `let (pool, _dir) = test_pool().await;`.
2. **Missing `settle()`** — materializer's background tx contends with the next write. After delete / edit / restore / purge / create page / create tag, settle before continuing.
3. **Wrong tokio flavor** — Materializer tests deadlock on default single-threaded.
4. **Snapshot without redaction** — ULIDs / timestamps / hashes break the snap on every run.
5. **`cargo sqlx prepare` skipped** — compile-time `query!` macros need offline cache regeneration after SQL changes.
6. **Specta drift** — Rust types in Tauri commands changed without `cargo test -- specta_tests --ignored`.
7. **Timestamp `assert_ne!` without sleep** — consecutive ms-precision timestamps can collide.
8. **Recursive CTE missing `is_conflict = 0`** — conflict copies leak in as phantom rows (root AGENTS.md invariant #9).
9. **`unwrap()` outside test code; `.ok()` swallowing errors** on core paths. `tracing::warn!` + explicit fallback over silent discard. Mutex `.expect("…poisoned")` should be `.unwrap_or_else(|e| e.into_inner())`.
10. **Adding command params breaks integration tests mechanically** — all call sites in `command_integration_tests/` must update; the compiler catches them all.
11. **`apply_snapshot` enqueues cache-rebuild tasks** — `apply_snapshot(pool, materializer, compressed)` deletes the cache tables, inserts snapshot data, enqueues the full rebuild set before returning. Tests asserting on cache state post-restore must call `materializer.flush_background().await` first.

## Cross-references

- Root [`AGENTS.md`](../../AGENTS.md) — 9 architectural invariants.
- [`../src/commands/AGENTS.md`](../src/commands/AGENTS.md) — command patterns (`_inner`, `CommandTx`, `MAX_BATCH_BLOCK_IDS`, `LAST_APPEND`, `AppError` prefixes) tests should verify.
- [`../src/mcp/AGENTS.md`](../src/mcp/AGENTS.md) — MCP rules.
- [`../migrations/AGENTS.md`](../migrations/AGENTS.md) — migration rules.
- [`../../src/__tests__/AGENTS.md`](../../src/__tests__/AGENTS.md) — frontend tests (separate world).
