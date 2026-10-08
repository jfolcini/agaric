# Rust backend test patterns

> Backend-tree rules: [`commands`](../src/commands/AGENTS.md), [`mcp`](../src/mcp/AGENTS.md), [`migrations`](../migrations/AGENTS.md). Frontend tests: [`src/__tests__`](../../src/__tests__/AGENTS.md).

## Test layers

| Layer | Where | What |
|---|---|---|
| Unit | `#[cfg(test)] mod tests` in the module, or a sibling `tests.rs` | Single-module logic |
| Integration | `src-tauri/src/integration_tests.rs`, `src-tauri/tests/command_integration/` | Cross-module pipelines; every `*_inner` command's API contract (happy path, error variants, edge cases, op-log verification) |
| Conformance | `src-tauri/tests/command_integration/conformance.rs`, `conformance_query.rs` | Backend-authored fixtures asserted by both the Rust backend and the TS mock |
| Sync | `src-tauri/agaric-sync/src/` (inline `mod tests`), `src-tauri/agaric-sync/src/sync_daemon/tests.rs`, `src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer_tests.rs` | mDNS wire format, transport, discovery lifecycle, peer flows, snapshot transfer |
| Bench | `src-tauri/benches/*.rs` (`harness = false`) | Criterion microbenchmarks; weekly CI lane only, see `src-tauri/benches/AGENTS.md` |

### The three integration-test binaries

`src-tauri/tests/` holds `app_tests/`, `commands/` and `command_integration/`, each a `main.rs` root with its suites as sibling modules (a `tests/commands.rs` root would resolve `mod foo;` to `tests/foo.rs`, E0583). Add a suite as a module of an existing binary, not a new binary: each root links `agaric_lib` afresh. Inside them lib paths are `agaric_lib::`, so anything reached must be `pub` or `#[cfg(any(test, feature = "test-util"))]` (`commands::tests::common` takes the latter route).

## Running tests

The package is `agaric` (filter with `-p agaric` / `package(agaric)`); `agaric_lib` is only the import path.

```bash
. "$HOME/.cargo/env"                                  # once per shell if cargo is not on PATH
cargo test --doc --workspace                          # doctests; nextest cannot run them

cargo nextest run --workspace -E 'test(create_block_returns)'   # by name substring
cargo nextest run -p agaric -E 'test(op_log::)'                 # by module
cargo nextest run -p agaric -E 'binary(command_integration)'    # one whole test binary

cargo insta test                                      # writes .snap.new for changed snapshots
cargo insta review                                    # accept / reject
```

Selectors that silently run nothing or the wrong set:

- `cargo nextest run 'test(x)'` without `-E` is a name-substring filter for the literal `test(x)` and matches zero tests.
- `cargo test` filters are substrings: `integration_tests` also selects `command_integration_tests`.
- A test file not declared with `mod` in its `main.rs` (or parent module) is never compiled, so its filter matches zero tests.
- Read the reported test count, not the exit code. When the only failures are the tests you just wrote, suspect a stale binary from an OOM-killed build: compare the count against the source, then `cargo clean -p <crate>` and rerun before touching code.

## Process-global state

Plain `cargo test` runs a crate's tests as threads in one process, so a test touching process-global state can pass vacuously, fail on another test's ordering, or flip between runs (#4102). nextest gives each test its own process; use it for these two shapes:

1. **The `tracing` subscriber and `log::max_level()`.** `init_logging` (`src-tauri/src/lib.rs`) installs them process-wide; `log_bridge_tests`, `boot_path_tests` and `log_dir_tests` need a clean process.
2. **Counter-delta tests**: read a process-global counter, act, read again, assert on the difference. Here that is `sql_only_fallback::count()` (re-exported as `sql_only_fallback_count()`), usually asserting `delta == 0` to prove the op took the engine path (#891); a sibling's fallback in the same process flips it. Find the current readers with:

   ```sh
   grep -rnE 'sql_only_fallback(::count|_count)\(\)' src-tauri/src src-tauri/tests src-tauri/agaric-engine/src
   ```

   `coordinator.rs` is the production reader, not a hazard.

A new test of either shape says so in its doc comment.

## Fixtures

### Database

DB-backed tests use `test_pool()` (shared in `commands::tests::common`, or a module-local copy of the same shape):

```rust
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    (pool, dir)
}
```

Bind `let (pool, _dir) = test_pool().await;`: `let (pool, _) = …` drops the `TempDir` at once and the SQLite file vanishes. Split read/write pools: `test_pools()` in `src-tauri/src/db/tests.rs`.

### Async attribute

```rust
#[tokio::test]                                                // pure DB tests
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]   // anything using Materializer
#[test]                                                       // pure logic (serde, hashing)
```

Materializer tests need `multi_thread`; on the single-threaded executor background tasks cannot progress and the test deadlocks.

### Materializer settle

After ops that dispatch background cache work (edit, delete, restore, purge, create page or tag, `apply_snapshot`), call `materializer.flush_background().await` (the shared `settle(&mat)`) before the next write or any cache assertion; a fixed sleep races the consumer. For the block-count cache, `Materializer::wait_for_initial_block_count_cache` waits for startup population (call it before overwriting `cached_block_count`) and `wait_for_pending_block_count_refreshes` for in-flight refreshes.

### Naming and helpers

- Test names read as assertions, no `test_` prefix: `edit_deleted_block_returns_not_found`. Snapshot tests: `snapshot_<what>`.
- Shared fixtures (`DEV`, `FIXED_TS`, `TEST_SPACE_ID`, `test_pool`, `insert_block`, `settle`, the space helpers) live in `commands::tests::common` (`src-tauri/src/commands/tests/common.rs`); the `tests/commands/` suites reach them through `prelude.rs`. Use them before writing a module-local copy.
- ULID fixtures uppercase (Crockford base32, blake3 determinism). Positions 1-based.

### Assertions

```rust
assert!(matches!(result, Err(AppError::NotFound(_))), "editing nonexistent block must return NotFound");
assert_eq!(err.validation_code(), Some(ValidationCode::InvalidGlob));   // typed sub-kind, not a message prefix
```

- Every assertion carries a message.
- Every command tests nonexistent ID → `NotFound`, deleted block → `NotFound`, invalid input → `Validation`.
- State-changing ops verify the op log: count, `op_type`, payload, hash chain. The log is append-only; reverse ops (`src-tauri/agaric-engine/tests/reverse_tests.rs`) are appended, never mutate existing records. Non-reversible ops return `AppError::NonReversible`, not a panic.
- Recursive-CTE tests verify `is_conflict = 0` and `depth < 100` (root `AGENTS.md` invariant #9).

### Test shapes that stay green with the fix reverted

- The fixture INSERTs into a derived table (`block_tag_refs`, a cache) instead of seeding the inputs through the production write path, so it reaches a state production never produces.
- An FK `ON DELETE CASCADE` removes the rows the code under test was supposed to remove.
- The test runs an inline copy of the SQL instead of calling the production function.
- The assertion holds for two reasons (an absence check on a message nothing emits; a reused block that already had the asserted state). Seed a fresh block for each pin.
- A scale or perf test sized too small for the regression to show. Inject the regression and confirm it reds.
- Two tasks meant to overlap, ordered by a sleep. Use a readiness handshake (`tokio::sync::oneshot`).

`#[should_panic]` on a `debug_assert!` needs `#[cfg(debug_assertions)]`, or it fails under `just test-be-release`.

### Determinism

- `FIXED_TS` over `now()`; `append_local_op_at` (caller timestamp) over `append_local_op` (wall clock).
- `now_rfc3339()` has millisecond precision, so two calls can collide; use constants before `assert_ne!` on timestamps.
- `FxHashSet` iteration order is unstable: use `BTreeSet` or sort before comparing.
- After changing a proptest generator, run it at volume (about 20000 cases, a few times). `PROPTEST_CASES` is ignored by a `with_cases(N)` or `cases: N` config, so raise the constant locally. Delete any `proptest-regressions/*.txt` seed that recorded a mutant rather than a real defect.

## Snapshot testing (insta)

Snapshots live in a `snapshots/` directory beside the tests; a new snapshot-testing module gets its own.

Redact non-deterministic fields:

```rust
insta::assert_yaml_snapshot!(resp, {
    ".id" => "[ULID]",
    ".deleted_at" => "[TIMESTAMP]",
    ".hash" => "[HASH]",
    ".next_cursor" => "[CURSOR]",
    "[].hash" => "[HASH]",          // array element redaction
});
```

Deterministic values need no redaction: the `snapshot-redaction` hook allowlists values that appear verbatim in a `.rs` file.

Named snapshots in loops: `insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), value)`.

## Conformance fixtures

`conformance/fixtures/*.json` pin every mutating command (and read commands via a `queries` array) against both the Rust backend and the TS mock (`src/lib/tauri-mock/__tests__/conformance.test.ts`). An op with `"via": "command"` runs its `*_inner` instead of the payload replay and records its return value or refusal in `expected_ops` (#4670). Never hand-write `expected` / `expected_queries` / `expected_ops`; the backend authors them:

```bash
cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'
npx vitest run src/lib/tauri-mock     # from the repo root; red means the mock diverges — fix the mock, not the backend
npx oxfmt --write conformance/fixtures/   # from the repo root
```

- The update run rewrites every fixture in serde's layout. The `oxfmt` pass puts untouched ones back byte-for-byte; `git checkout -- conformance/fixtures/` would also revert the fixture you meant to change. Never parse and redump fixture JSON with Python: it expands arrays and escapes non-ASCII.
- A payload-replayed op pins the resulting state, not the command's return value. When the return value matters, use `"via": "command"`.
- Seed so the wrong answer differs from insertion order; otherwise an unsorted result passes an ordering pin.

## Mutants

An equivalent (unkillable) mutant is recorded in its tracking issue's `mutation-accepted` block (`scripts/file-mutation-survivors.mjs`), not chased with tests.

## Benchmarks

See [`../benches/AGENTS.md`](../benches/AGENTS.md). `cargo check --bench` proves nothing about a bench, and no PR gate runs them.
