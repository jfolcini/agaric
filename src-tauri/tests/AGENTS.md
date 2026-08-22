# Rust backend test patterns

> See also: root [`AGENTS.md`](../../AGENTS.md) for the architectural invariants tests must respect. Backend-tree-specific rules live in [`../src/commands/AGENTS.md`](../src/commands/AGENTS.md), [`../src/mcp/AGENTS.md`](../src/mcp/AGENTS.md), and [`../migrations/AGENTS.md`](../migrations/AGENTS.md).

## Test layers

| Layer | Where | What |
|---|---|---|
| Unit | `src/<module>.rs` → `#[cfg(test)] mod tests` (or `src/<module>/tests.rs`) | Single-module logic |
| Integration | `src/integration_tests.rs`, `src/command_integration_tests/` (incl. `sync_integration.rs`) | Cross-module pipelines + command API contracts + sync peer-ref/protocol commands |
| Sync (network) | `src-tauri/agaric-sync/src/mdns.rs` (inline), `src/sync_net/tests.rs`, `src/sync_daemon/tests.rs`, `src/sync_daemon/snapshot_transfer_tests.rs` (+ `_host.rs`) | mDNS announce/parse wire format, TLS/cert + wire protocol, mDNS discovery lifecycle + peer-sync flows, snapshot transfer round-trips |
| Bench | `benches/*.rs` (`harness = false`) | Criterion microbenchmarks; not a per-PR gate — CI runs them in the **weekly** `bench-smoke` / `bench-slo` lanes (see `benches/AGENTS.md`) |

Plus `src/lib.rs` carries `specta_tests` for TypeScript binding verification.

## Running tests

> **Package vs lib target:** the cargo **package** is `agaric`; the **lib target** is `agaric_lib`. Use `-p agaric` / `package(agaric)` for filters — `-p agaric-lib` errors. `agaric_lib` only appears as a Rust import path (`use agaric_lib::…`) in benches / integration tests.

```bash
. "$HOME/.cargo/env"             # required once per shell on this machine

cargo nextest run --workspace      # REQUIRED runner for the suite (parallel, retries) — bare
                                   # `cargo nextest run` is package-scoped to `agaric` ONLY and
                                   # silently skips agaric-core/store/engine/sync/observability/
                                   # diagnostics — compare `cargo nextest list` (agaric only) vs
                                   # `cargo nextest list --workspace` (all 7 members) if you want
                                   # today's counts; #3212 has the root cause (no
                                   # `default-members`, deliberately). Required, not just preferred:
                                   # several tests depend on nextest's
                                   # process-per-test isolation — see "Process-global state"
                                   # below. Under plain `cargo test` they can pass
                                   # vacuously, fail, or flip between runs depending on thread
                                   # scheduling (#4102).
cargo test --doc --workspace       # doctests ONLY — nextest does not run doctests, so this
                                   # covers the one thing it can't. It is NOT a general
                                   # substitute for `cargo nextest run` above.

cargo nextest run -p agaric create_block_returns           # by name substring
cargo nextest run -p agaric -E 'test(op_log::)'            # by module

cargo test -p agaric -- integration_tests --skip command_integration_tests   # OK on cargo test:
                                   # `src/integration_tests.rs` touches no process-global (each
                                   # test builds its own `LoroEngineRegistry`, and the module
                                   # deliberately does not read `sql_only_fallback_count()` — see
                                   # its top-of-file comment). Verified: 5 full-module runs,
                                   # default parallel threads, 0 failures. The `--skip` is NOT
                                   # decoration: `command_integration_tests` contains
                                   # `integration_tests` as a substring, so a bare `-- integration_tests`
                                   # filter ALSO matches every test under `command_integration_tests::`
                                   # (350+ extra tests, conformance included) — silently pulling in
                                   # the exact process-global-counter tests this line claims to avoid.
cargo nextest run -p agaric -E 'test(command_integration_tests::)'   # REQUIRED nextest, not
                                   # `cargo test`: `conformance.rs` reads the process-global
                                   # `sql_only_fallback_count()` as a per-test before/after
                                   # delta and asserts it == 0, which races against every OTHER
                                   # conformance test's concurrent fallback events once `cargo
                                   # test` runs them as threads in one process. Reproduced: flaky,
                                   # not deterministic — 1 failure in 10 default-parallel `cargo
                                   # test` runs of this module (e.g.
                                   # `local_move_block_parity_local_matches_remote_2344`; a
                                   # DIFFERENT conformance test can fail on a different run,
                                   # depending on thread scheduling); 0 failures across 3 nextest
                                   # runs. Don't expect that 1-in-10 rate to hold — it's a race,
                                   # not a fixed frequency; treat any flake in this module under
                                   # plain `cargo test` as confirming the bug, not as noise. (Root
                                   # AGENTS.md's older reason — a process-global Loro engine
                                   # registry shared by `conformance`/`undo_integration` — was
                                   # fixed by #2249; both files' own doc comments now say their
                                   # engine state is per-test. The counter above is what still
                                   # makes this module nextest-only.)
cargo nextest run -p agaric -E 'test(sync_net::) + test(sync_daemon::)'   # network sync

cargo insta test          # snapshot tests; writes .snap.new for changed
cargo insta review        # interactive accept/reject

cargo test -p agaric -- specta_tests --ignored   # regenerate src/lib/bindings.ts — a codegen
                                   # action (writes a file), not a correctness assertion, so
                                   # process isolation doesn't apply here; `cargo test` is fine.
                                   # Verified clean: running it produced no diff in
                                   # `src/lib/bindings.ts` (already up to date). nextest
                                   # equivalent, verified to select/run the same single test:
                                   # `cargo nextest run -p agaric -E 'test(specta_tests::)'
                                   # --run-ignored=only` — prefer this form; `-- --ignored` after
                                   # the filter also works (nextest emulates it), but
                                   # `--run-ignored=only` is the documented, canonical flag.

cargo bench --bench core_bench -- hash   # local only (hash_bench is a mod of core_bench, #2879)
```

### Nextest configuration (`src-tauri/.config/nextest.toml`)

- `fail-fast = false` — always runs everything even if some fail.
- `retries = 1` (default), `retries = 2` (CI profile).
- `slow-timeout = 30s` default, `60s` CI — DB-backed tests can be slow on cold cache.

## Writing unit tests

### Process-global state

If a test touches something that is global to the OS process — a `tracing` global default subscriber, `log::max_level()`, mutated process env vars (`std::env::set_var`), or an `OnceLock`/registry seeded once and read everywhere — it must not assume it is alone in the process. `cargo nextest run` gives every test its own process, so this is invisible there; plain `cargo test` runs a crate's tests as threads sharing ONE process, so these tests can pass vacuously (the assertion is satisfied by a leftover from an earlier test, not by the call under test), fail on an ordering they didn't cause, or flip between runs (#4102).

Concrete instances in this crate: `init_logging` (`src/lib.rs`) installs the process-wide `tracing` subscriber via `try_init().ok()` and calls `init_log_bridge`, which sets `log::max_level()` — `log_bridge_tests::init_log_bridge_makes_log_crate_records_reachable`, `boot_path_tests::init_logging_completes_the_real_boot_sequence`, and `log_dir_tests::log_dir_write_path_and_bug_report_read_path_agree` all assert on that shared state and are documented as needing a clean process.

`command_integration_tests::conformance` is the same class of bug from a different source: several of its tests read the process-global `crate::materializer::sql_only_fallback_count()` before and after their own op and assert the delta is `0`, to prove THEIR op took the engine path rather than the SQL-only fallback (#891). Under `cargo test`'s shared process, another conformance test's concurrent fallback event lands on the same counter and can flip that delta nonzero for a test that never touched the fallback path itself — reproduced directly (see "Running tests" above). Root [`AGENTS.md`](../../AGENTS.md) also names this module as nextest-only, but for an older reason (a process-global Loro engine registry) that `conformance.rs` and `undo_integration.rs` now document as fixed (#2249: each test's engine state is its own `Materializer`'s, not shared) — the counter above is the reason the module still needs nextest today. If you're adding a test like this, say so in a doc comment the way those do, rather than leaving the next person to rediscover it — and prefer a delta/lower-bound check over an exact one if the counter is genuinely shared with concurrently-running tests.

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

// For typed validation sub-kinds (#2251 — the code is a structured field,
// NOT a message prefix; `to_string()` is just "Validation error: <reason>"):
let err = result.unwrap_err();
assert_eq!(err.validation_code(), Some(ValidationCode::InvalidGlob));
```

### Assertion style

- `assert_eq!` with a descriptive message.
- `assert!(matches!(...))` for enum variants.
- `insta::assert_yaml_snapshot!` for complex response structures (see Snapshot Testing).
- **Exact counts only** — `assert_eq!(count, 5)` not `assert!(count >= 1)`. Inequality hides duplicate-result / missing-filter bugs.

## Writing integration tests

Integration test surfaces, all `#[cfg(test)] mod` includes in `lib.rs` (they compile as part of the lib crate's test binary, not separate binaries):

- **`src/integration_tests.rs`** — pipeline tests spanning 3+ modules. Op chains + hash, crash recovery, cascade delete/purge, pagination, position handling, materializer dispatch, edit sequences. Use `create_content()` shorthand + `settle_bg_tasks()` between materializer-triggering ops.
- **`src/command_integration_tests/`** (`block`/`page`/`tag`/`property`/`backlink`/`lifecycle`/`sync`/`trash`/`undo` integration modules + `common.rs` + `mod.rs`) — every `*_inner` command's API contract. Happy path + error variants + edge cases (empty / unicode / large / concurrent) + op-log verification. The sync surface here is `sync_integration.rs` (peer-ref commands: `list_peer_refs` / `update_peer_name` / `delete_peer_ref`, scheduler wiring).
- **Network sync** lives outside the `command_integration_tests/` tree: `agaric-sync/src/mdns.rs`'s inline tests (the mDNS wire format: service type, the announced TXT record, `parse_service_event` — moved out of the app crate in #3488), `src/sync_net/tests.rs` (TLS/cert generation, wire-message serialisation), `src/sync_daemon/tests.rs` (mDNS discovery lifecycle — `process_discovery_event`, stale-peer eviction — plus `try_sync_with_peer_*` / `inmem_handle_incoming_sync_*` peer flows and backoff/conflict handling), and `src/sync_daemon/snapshot_transfer_tests.rs` (snapshot transfer round-trips). The crate-level `src/sync_integration_tests.rs` (diffy-era E2E) was **deleted** when the Loro-native sync layer landed; a full TLS+WS socket round-trip remains deferred (#602). Do not cite `sync_integration_tests.rs` as a live layer.

**Reverse-op tests (`reverse.rs`):** test the reverse of each op type. Non-reversible ops (`purge_block`, `delete_attachment`) must return `AppError::NonReversible`, not panic. Prior-state lookups use the op log exclusively (not the materialised `blocks` table), so tests verify op-log walking even when the materializer lags. Reverse ops are **appended** to the op log — never assert existing ops were mutated. Use `append_local_op_at` with `FIXED_TS` for deterministic timestamps.

## Snapshot testing (insta)

Snapshots live alongside the code — e.g. `src/commands/tests/snapshots/`, `src/mcp/tools_ro/snapshots/` and `tools_rw/snapshots/`, `agaric-store/src/snapshots/`, `agaric-store/src/backlink/snapshots/`, `agaric-store/src/pagination/snapshots/`, `agaric-store/src/op_log/tests/snapshots/`. Naming: `agaric_lib__<module>__tests__<test_name>.snap` for app-crate modules and `agaric_store__<module>__tests__<test_name>.snap` for modules that have moved into `agaric-store` (#2621). New snapshot-testing modules get a sibling `snapshots/` directory.

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

The `benches/*.rs` files cover the hot-path functions (create / edit / list / search / pagination / FTS / hash / agenda / properties / sync / undo etc.). Parameterised scales typically 100 / 1K / 10K / 100K where size matters.

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

- Not run per-PR or in pre-commit, but **CI does run every bench weekly**: `.github/workflows/scheduled-deep-checks.yml` carries `bench-smoke` (sharded compile + a `--test` smoke run that fails on a drifted seed/fixture) and `bench-slo` (the warm `interactive_slo` budget gate), on the Monday cron plus manual `workflow_dispatch`. Nothing in `ci.yml` / `_validate.yml` gates a PR on a bench, so a break you don't catch locally surfaces up to a week later, attributed to an unrelated PR. `benches/AGENTS.md` is the source of truth for the lanes and the pitfalls.
- Each bench gets its own temp DB with `TempDir`.
- Shut down the materializer after each bench group.
- Parameterise size comparisons via `BenchmarkId::from_parameter`.
- **Run the bench before committing, don't just compile it.** `cargo check --bench <name>` / `--no-run` proves only that it builds — a hand-seeded raw-SQL fixture that has drifted from the live schema compiles fine and panics the moment it executes (#1233). Mirror CI's smoke gate locally: `cargo bench --no-run` once, then run each prebuilt binary with `--test`; `benches/AGENTS.md` § "Run the smoke gate locally before pushing" has the exact loop (it also dodges the cargo #6313 build-race). Visibility on `*_inner` may still need `pub` — bench files are separate crates.

## Test file checklist

Before committing:

- DB tests bind `_dir` so `TempDir` outlives the pool.
- Async tests use `#[tokio::test]` (or `multi_thread, worker_threads = 2` for materializer).
- Materializer-triggering ops followed by `settle()` / `mat.flush_background()` before the next write.
- Names read as assertions (`x_returns_y`, not `test_x`).
- Error paths covered: nonexistent ID → `NotFound`, deleted → `NotFound`, invalid input → `Validation`.
- Snapshot tests redact `.id` / `.created_at` / `.hash` / `.next_cursor`.
- Helpers module-local (don't share across modules).
- Recursive-CTE tests verify the `is_conflict = 0` + `depth < 100` invariants from root AGENTS.md invariant #9.
- Op-log assertions check the appended record (no mutation — append-only).
- `assert_eq!` for exact counts.
- ULID fixtures uppercase (Crockford base32 → blake3 determinism).
- Position values 1-based, not 0.
- Benchmarks declared `harness = false`, and actually **run** (not just compiled) before committing — the weekly lane is the only CI that executes them.
- SQL changes: `just gen-sqlx` run and every regenerated `.sqlx/` file committed.

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
5. **`just gen-sqlx` skipped** — compile-time `query!` macros need offline cache regeneration after SQL changes, across all four `.sqlx/` lanes.
6. **Specta drift** — Rust types in Tauri commands changed without `cargo test -- specta_tests --ignored`.
7. **Timestamp `assert_ne!` without sleep** — consecutive ms-precision timestamps can collide.
8. **Recursive CTE missing `is_conflict = 0`** — conflict copies leak in as phantom rows (root AGENTS.md invariant #9).
9. **`unwrap()` outside test code; `.ok()` swallowing errors** on core paths. `tracing::warn!` + explicit fallback over silent discard. Mutex `.expect("…poisoned")` should be `.unwrap_or_else(|e| e.into_inner())`.
10. **Adding command params breaks integration tests mechanically** — all call sites in `command_integration_tests/` must update; the compiler catches them all.
11. **`apply_snapshot` enqueues cache-rebuild tasks** — `apply_snapshot(pool, materializer, compressed)` deletes the cache tables, inserts snapshot data, enqueues the full rebuild set before returning. Tests asserting on cache state post-restore must call `materializer.flush_background().await` first.

## Cross-references

- Root [`AGENTS.md`](../../AGENTS.md) — the architectural invariants.
- [`../src/commands/AGENTS.md`](../src/commands/AGENTS.md) — command patterns (`_inner`, `CommandTx`, `MAX_BATCH_BLOCK_IDS`, `LAST_APPEND`, `ValidationCode`) tests should verify.
- [`../src/mcp/AGENTS.md`](../src/mcp/AGENTS.md) — MCP rules.
- [`../migrations/AGENTS.md`](../migrations/AGENTS.md) — migration rules.
- [`../../src/__tests__/AGENTS.md`](../../src/__tests__/AGENTS.md) — frontend tests (separate world).
