# Benches

Criterion benches under `src-tauri/benches/`. `interactive_slo` additionally enforces per-command mean-latency budgets at 100K blocks (`docs/architecture/operations.md` § Product SLO). `cargo check` / `--no-run` proves nothing about a bench: the fixtures are hand-seeded raw SQL and only fail when run.

## CI lanes

`.github/workflows/scheduled-deep-checks.yml` (weekly Monday cron + `workflow_dispatch`, not per-PR) runs two lanes:

- **`bench-smoke`** — sharded. Each shard builds its slice with `cargo bench --no-run --bench …`, then runs every binary once with `--test` (criterion's single-shot, no-measurement mode). A fixture that drifted from the schema panics here. This validates seeds, not perf.
- **`bench-slo`** — warm-runs the workflow's `SLO_BENCHES` (`interactive_slo`) plus the `#[ignore]`d 20k-row gates, apart from the smoke shards so a smoke timeout cannot skip it and cold timings cannot trip `assert_under_budget`. The `slo_include_problem` dispatch input adds the cache/counterfactual probes.

## Verifying a bench change: CI is the arbiter

Do not compile the release bench graph locally: `[profile.release]` is thin LTO with `codegen-units = 1`, which takes hours and gets OOM-killed on a shared box. Dispatch the lane on your branch instead; a non-`main` dispatch is a dry run that files nothing:

```bash
gh workflow run scheduled-deep-checks.yml --ref <branch> -f lanes=bench-smoke   # or bench-slo
```

A non-zero exit or `panicked at` in `bench-smoke` is a real fixture failure. An `assert_under_budget` failure under cold `--test` is not (cold runs inflate heavy benches 10x or more); only the warm `bench-slo` number gates.

The `#[ignore]`d gates in `bench-slo` run under nextest's `profile.default` (no `--profile`), so they are killed at 2x30s; a slow one needs an override in `src-tauri/.config/nextest.toml`.

Optional probes: `if problem_skipped("<name> @ 100K") { return }` gates the cache and MostLinked probes behind `SLO_INCLUDE_PROBLEM=1`; the permanently over-budget revert probe has its own `SLO_INCLUDE_REVERT=1`.

Before quoting a measured number in docs or a PR, check the fixture seeded what the bench claims; a dangling FK or a wrong scale changes the number, not the build.

Smoke shards build once with `cargo bench --no-run` and run the prebuilt binaries; separate `cargo bench --bench <name>` calls race on `libagaric_lib.*` (cargo #6313) and fail with `E0308 ... expected Pool<Sqlite>, found a different Pool<Sqlite>`.

## Shape probes: observe results outside timing

A schema or filter drift that turns a query into an empty result looks like a speedup and still passes the budget. So every default-enforced `interactive_slo` read command makes one untimed call after seeding, before its Criterion loop, and asserts the result shape — exact where stable (requested id set, page length, seeded count), nonempty only where the result is intentionally variable. The timed loop may keep discarding its result.

Do not preflight a mutator against the measured fixture (it changes the advertised scale). Assert durable growth after `group.finish()` instead; `create_block` is the model — fixture at exactly 100K before timing, then block and op-log counts each grow by `Acc::iters()`.

Put the same probe on any non-SLO bench whose fixture can degrade into a cheaper shape (`bench_export_page_markdown` in `src-tauri/benches/groups/export_bench.rs` is the model); those run in the `--test` lane, so the check fires every week.

**Placement:** in the outer bench function's body, after the seeder and outside every `bench_function` / `bench_with_input` / `iter_custom` closure, because only that body runs under both `--test` and a name filter.

## Seeding fixtures: the schema-drift checklist

Seeders use raw `sqlx::query(...)` and must match the live schema:

- **`op_log.created_at` is `INTEGER` epoch-ms** (migration 0079) — bind an `i64`, not an RFC-3339 string; the STRICT table rejects TEXT.
- **Reserved property keys** `('todo_state','priority','due_date','scheduled_date','space')` are `blocks` columns; migration 0088's `key_not_reserved` CHECK rejects them in `block_properties`. Use a free-form key or set the column.
- **Space membership is `blocks.space_id`** (0086) with a `spaces` registry FK (0089): insert the owner block, `INSERT OR IGNORE INTO spaces (id) VALUES (?)`, then set `space_id`. Never seed a `'space'` property row. Canonical filter: `(?N IS NULL OR b.space_id = ?N)` (`src-tauri/agaric-store/src/space_filter_canonical.rs`).
- **Every `'page'` block needs `page_id = id`** (0073 CHECK). `INSERT OR IGNORE` silently drops a violating page row, which surfaces later as an FK error.
- **Ids passed to commands must be valid ULIDs** — 26 chars Crockford base32, no `I/L/O/U`. `SpaceId::from_trusted` skips validation; a command path does not.
- **`op_log.block_id`** must be set on rows feeding revert/undo — `find_prior_text` filters on the column, not on `json_extract(payload)`.

Fixing one class usually exposes the next; rerun the smoke lane until clean.

## Layout: themed binaries + `groups/`

Groups live in `src-tauri/benches/groups/<name>.rs` and are pulled into five themed binaries (`engine_bench`, `query_bench`, `agenda_bench`, `io_bench`, `core_bench`) via `#[path = "groups/<name>.rs"] mod <name>;`, one link per theme. Keep `benchmark_group` / `bench_function` / `BenchmarkId` strings stable: `target/criterion/` baselines are keyed by them.

Two benches stay standalone: `interactive_slo` (CI invokes it by name; never fold it in) and `loro_vs_sql_reads` (hand-rolled `fn main()`, not criterion).

Pattern: one `TempDir` + DB per bench, `Runtime::block_on` for setup, `b.to_async(&rt).iter(...)`, `materializer.shutdown()` after each group, `BenchmarkId::from_parameter` for size sweeps. Benches are external crates, so `*_inner` may need `pub`.

Select a group with a name filter on its themed binary (`core_bench -- hash`). CI enumerates `[[bench]]` names, so a new themed binary needs no workflow change.

## Seeders are duplicated per group, on purpose

Each `groups/*.rs` carries its own `fresh_pool`, `seed_*`, `ts_for`. When you change a seeding pattern, grep the sibling files and keep them in sync.
