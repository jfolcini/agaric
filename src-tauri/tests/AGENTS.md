# Rust backend test patterns

> See also: root [`AGENTS.md`](../../AGENTS.md) for the architectural invariants tests must respect; [`../src/commands/AGENTS.md`](../src/commands/AGENTS.md), [`../src/mcp/AGENTS.md`](../src/mcp/AGENTS.md), [`../migrations/AGENTS.md`](../migrations/AGENTS.md) for backend-tree rules; [`../../src/__tests__/AGENTS.md`](../../src/__tests__/AGENTS.md) for frontend tests.

## Test layers

| Layer | Where | What |
|---|---|---|
| Unit | `#[cfg(test)] mod tests` in the module, or a sibling `tests.rs` | Single-module logic |
| Integration | `src-tauri/src/integration_tests.rs`, `src-tauri/tests/command_integration/` | Cross-module pipelines; every `*_inner` command's API contract (happy path, error variants, edge cases, op-log verification) |
| Conformance | `src-tauri/tests/command_integration/conformance.rs`, `conformance_query.rs` | Backend-authored fixtures asserted by both the Rust backend and the TS mock |
| Sync | `src-tauri/agaric-sync/src/` (inline `mod tests`), `src-tauri/src/sync_daemon/tests.rs`, `src-tauri/src/sync_daemon/snapshot_transfer_tests.rs` | mDNS wire format, transport, discovery lifecycle, peer flows, snapshot transfer |
| Bench | `src-tauri/benches/*.rs` (`harness = false`) | Criterion microbenchmarks; weekly CI lane only, see `src-tauri/benches/AGENTS.md` |

### The three integration-test binaries

`src-tauri/tests/` holds `app_tests/`, `commands/` and `command_integration/`,
each a directory with a `main.rs` root and its suites as sibling modules. The
`main.rs` shape is load-bearing: for a *crate root*, `mod foo;` resolves against
the root's own directory, so a `tests/commands.rs` root would look for
`tests/foo.rs`, not `tests/commands/foo.rs` (E0583). Cargo auto-discovers
`tests/<name>/main.rs` and names the binary `<name>`, so no `[[test]]` entry is
needed.

One binary per group, not per file: every integration-test root links
`agaric_lib` afresh, and the module tree gives the same isolation for free.
Inside them `crate::` means the test binary, so lib paths are `agaric_lib::`,
and anything they reach must be visible to an external crate — either `pub`, or
`#[cfg(any(test, feature = "test-util"))]` where it must stay out of a release
build (`commands::tests::common` is the fixture that takes this route).

`src-tauri/src/lib.rs` also carries `specta_tests` (TypeScript binding verification) and the `log_bridge_tests` / `boot_path_tests` / `log_dir_tests` modules.

## Running tests

Package is `agaric`; lib target is `agaric_lib`. Filter with `-p agaric` / `package(agaric)`; `agaric_lib` is only an import path in benches and integration tests.

```bash
. "$HOME/.cargo/env"                                  # once per shell on this machine

cargo nextest run --workspace                         # THE runner. Bare `cargo nextest run` is
                                                      # package-scoped to `agaric` and silently skips
                                                      # the other six workspace members (#3212).
cargo test --doc --workspace                          # doctests only — nextest cannot run them

cargo nextest run --workspace -E 'test(create_block_returns)'   # by name substring
cargo nextest run -p agaric -E 'test(op_log::)'                 # by module
cargo nextest run -p agaric -E 'binary(command_integration)'    # one whole test binary
cargo nextest run -p agaric -E 'test(convergence)'

cargo insta test                                      # writes .snap.new for changed snapshots
cargo insta review                                    # accept / reject

cargo nextest run -p agaric -E 'test(specta_tests::)' --run-ignored=only   # regenerate src/lib/bindings.ts
```

Use nextest, not plain `cargo test`, for anything in the `command_integration` binary or under `materializer::handlers::` — see "Process-global state". `cargo test` runs a crate's tests as threads in one process; nextest gives each test its own process.

Nextest configuration lives in `src-tauri/.config/nextest.toml`: `fail-fast = false`, `retries = 1` (`2` in the `ci` profile), `slow-timeout` 30s (60s in CI), and a single-threaded `spy-counter-serial` test group for the counter-delta handler tests.

## Process-global state

A test that touches something global to the OS process must not assume it is alone in the process. Under plain `cargo test` such a test can pass vacuously (satisfied by a leftover from an earlier test), fail on an ordering it did not cause, or flip between runs (#4102). `cargo nextest run` isolates each test in its own process, which is why it is the required runner.

Two classes in this crate:

1. **The `tracing` subscriber and `log::max_level()`.** `init_logging` in `src-tauri/src/lib.rs` installs the process-wide subscriber via `try_init().ok()` and calls `init_log_bridge`. `log_bridge_tests`, `boot_path_tests` and `log_dir_tests` assert on that shared state and need a clean process.
2. **Counter-delta tests.** Any test that reads a process-global counter, does its work, reads it again and asserts on the difference. The counter here is `sql_only_fallback::count()` (re-exported as `crate::materializer::sql_only_fallback_count()`), a monotonic `AtomicU64`; the assertion is nearly always `delta == 0`, proving the op took the engine path rather than the SQL-only fallback (#891). A sibling test's fallback event in the same process flips the delta for a test that never touched the fallback. This is a shape, not a module list — find the current readers with:

   ```sh
   grep -rnE 'sql_only_fallback(::count|_count)\(\)' src-tauri/src src-tauri/tests
   ```

   `src-tauri/src/materializer/coordinator.rs` is the production reader, not a hazard. The mechanism is documented in `src-tauri/agaric-engine/src/loro/shared.rs`.

Root `AGENTS.md` states the same rule under "Running tests efficiently" and defers here for the grep; keep the two agreeing. The old rationale (a shared process-global Loro engine registry) was fixed in #2249 — do not reinstate it. When adding a test of either shape, say so in its doc comment.

## Fixtures

### Database

Every DB-backed test defines a module-local `test_pool()`:

```rust
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    (pool, dir)
}
```

Bind `_dir` so the `TempDir` outlives the pool: `let (pool, _dir) = test_pool().await;`. `let (pool, _) = …` drops the directory immediately and the SQLite file vanishes. Tests needing split read/write pools use `test_pools()` in `src-tauri/src/db/tests.rs`, returning `(DbPools, TempDir)`.

### Async attribute

```rust
#[tokio::test]                                                // pure DB tests
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]   // anything using Materializer
#[test]                                                       // pure logic (serde, hashing)
```

Materializer tests require `multi_thread`: the single-threaded executor deadlocks because background tasks cannot progress.

### Materializer settle

After ops that dispatch background cache-rebuild work (edit / delete / restore / purge / create page / create tag), sleep before the next write to avoid SQLite write-lock contention with the background consumer:

```rust
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}
```

Not needed after creating content blocks. `materializer.flush_background().await` waits for the queue to drain; `apply_snapshot` enqueues a full rebuild, so tests asserting on cache state after a restore must flush first. `Materializer::wait_for_initial_block_count_cache` (startup population, call before overwriting `cached_block_count`) and `wait_for_pending_block_count_refreshes` (in-flight refreshes, e.g. after an FTS optimize) gate the block-count cache.

### Naming and helpers

- Test names read as assertions, no `test_` prefix: `edit_deleted_block_returns_not_found`. Snapshot tests: `snapshot_<what>`.
- Fixture constants (`DEV`, `FIXED_TS`, `FAKE_HASH`) and helpers (`test_pool`, `insert_block`, `make_create_payload`) are module-local. Duplication is intentional; there is no shared test utility crate.
- ULID fixtures uppercase (Crockford base32, blake3 determinism). Positions 1-based.

### Assertions

```rust
assert!(matches!(result, Err(AppError::NotFound(_))), "editing nonexistent block must return NotFound");
assert_eq!(err.validation_code(), Some(ValidationCode::InvalidGlob));   // typed sub-kind, not a message prefix
```

- Every assertion carries a message.
- Exact counts: `assert_eq!(count, 5)`, never `assert!(count >= 1)` — inequality hides duplicate-result and missing-filter bugs.
- Every command tests nonexistent ID → `NotFound`, deleted block → `NotFound`, invalid input → `Validation`.
- State-changing ops verify the op log: count, `op_type`, payload, hash chain. The log is append-only; reverse ops (`src-tauri/src/reverse/tests.rs`) are appended, never mutate existing records. Non-reversible ops return `AppError::NonReversible`, not a panic.
- Recursive-CTE tests verify `is_conflict = 0` and `depth < 100` (root `AGENTS.md` invariant #9).

### Determinism

- `FIXED_TS` over `now()`; `append_local_op_at` (caller timestamp) over `append_local_op` (wall clock).
- `now_rfc3339()` has millisecond precision: two calls in the same ms collide. Sleep 2ms or use constants before `assert_ne!` on timestamps.
- `FxHashSet` iteration order is unstable: use `BTreeSet` or sort before comparing.
- `settle()` avoids lock contention; it is not a timing assertion.

## Snapshot testing (insta)

Snapshots live in a `snapshots/` directory beside the tests (`src-tauri/tests/commands/snapshots/`, `src-tauri/src/mcp/tools_ro/snapshots/`, `src-tauri/agaric-store/src/snapshots/`, …). File name: `agaric_lib__<module>__tests__<test_name>.snap` for in-lib app-crate modules, `commands__snapshot_tests__<test_name>.snap` for the `tests/commands/` binary, `agaric_store__…` for `agaric-store`. A new snapshot-testing module gets its own sibling `snapshots/`.

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

For deterministic data, no redaction needed — values that appear verbatim in a `.rs` source file are allowlisted by the `snapshot-redaction` pre-commit guard (`prek.toml`).

Named snapshots in loops: `insta::assert_yaml_snapshot!(format!("op_payload_json_{tag}"), value)`.

## Conformance fixtures

`conformance/fixtures/*.json` pin every mutating command (and read commands via a `queries` array) against both the Rust backend and the TS mock (`src/lib/tauri-mock/__tests__/conformance.test.ts`). Never hand-write `expected` / `expected_queries`; the backend authors them:

```bash
cd src-tauri && CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'
npx vitest run src/lib/tauri-mock     # from the repo root; red means the mock diverges — fix the mock, not the backend
```

## Benchmarks

Pattern: one `TempDir` + DB per bench, `Runtime::block_on` for setup, `b.to_async(&rt).iter(...)`, `materializer.shutdown()` after each group, `BenchmarkId::from_parameter` for size sweeps. Bench files are separate crates, so `*_inner` may need `pub`.

Run the bench before committing, not just `cargo check --bench`: a hand-seeded raw-SQL fixture that has drifted from the schema compiles fine and panics on execution (#1233). No PR gate runs benches; `.github/workflows/scheduled-deep-checks.yml` runs them weekly, so a break surfaces a week later on someone else's PR. `src-tauri/benches/AGENTS.md` § "Run benches without the E0308 build race" has the exact loop.

## Before committing

- `_dir` bound; correct tokio flavor; `settle()` / `flush_background()` after materializer-triggering ops.
- Snapshot redactions in place.
- SQL changes: `just gen-sqlx` run and every regenerated `.sqlx/` file (all four crates) committed.
- Tauri command types changed: regenerate `src/lib/bindings.ts` (command above).
- New command params: update every call site in `src-tauri/tests/command_integration/`; the compiler finds them.
- No `unwrap()` outside test code; no `.ok()` swallowing errors on core paths. Mutex poisoning: `.unwrap_or_else(|e| e.into_inner())`.
