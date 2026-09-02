# Benches

Criterion benches under `src-tauri/benches/`. `interactive_slo` additionally enforces per-command mean-latency budgets at 100K blocks (`docs/architecture/operations.md` § Product SLO). `cargo check` / `--no-run` proves nothing about a bench: the fixtures are hand-seeded raw SQL and only fail when run.

## CI lanes

`.github/workflows/scheduled-deep-checks.yml` (weekly Monday cron + `workflow_dispatch`, not per-PR) runs two lanes:

- **`bench-smoke`** — sharded. Each shard builds its slice with `cargo bench --no-run --bench …`, then runs every binary once with `--test` (criterion's single-shot, no-measurement mode). A fixture that drifted from the schema panics here. This validates seeds, not perf.
- **`bench-slo`** — warm-runs the benches listed in the workflow's `SLO_BENCHES` env (currently `interactive_slo`) plus the `#[ignore]`d 20k-row gates. Separate from the smoke shards so a smoke timeout cannot skip it, and excluded from the cold `--test` loop so `assert_under_budget` is not tripped by cold timings. The `slo_include_problem` dispatch input also measures the cache/counterfactual probes.

## Run benches without the E0308 build race

`cargo bench --bench <name> -- --test` intermittently fails with:

```
error[E0308]: mismatched types ... expected `Pool<Sqlite>`, found a different `Pool<Sqlite>`
warning: output filename collision at .../libagaric_lib.rlib
```

This is cargo #6313, not your code: `agaric`'s `[lib]` has several crate-types that race to write `target/release/deps/libagaric_lib.*`, so a bench can link a second `sqlx` instance. Every per-`--bench` recompile re-rolls the dice. Build once, then run the prebuilt binaries:

```bash
cd src-tauri
cargo bench --no-run                                  # one cohesive build; if it flakes, rerun it
for name in $(grep -A1 '^\[\[bench\]\]' Cargo.toml \
    | sed -n 's/^name = "\(.*\)"/\1/p' | grep -vx interactive_slo); do
  bin=$(ls -t "target/release/deps/${name}-"* | grep -vE '\.(d|so|dwp)$' | head -1)
  echo "smoke $name"; "$bin" --test || { echo "FAILED: $name"; break; }
done
```

A non-zero exit or `panicked at` is a real fixture failure. Themed binaries with heavy 100K-seed groups (e.g. `core_bench`) are slow under cold `--test`; to smoke one group, filter: `"$bin" --test cache`.

## Cold `--test` vs warm budgets

`--test` runs each bench once, cold, which inflates heavy benches 10x or more. An `assert_under_budget` failure under `--test` is not a verdict. Decide with a warm run — `cargo bench --bench interactive_slo` — and gate only on that number.

Optional probes: `if problem_skipped("<name> @ 100K") { return }` gates the cache and MostLinked probes behind `SLO_INCLUDE_PROBLEM=1`; the permanently over-budget revert probe has its own `SLO_INCLUDE_REVERT=1`.

## Shape probes: observe results outside timing

A schema or filter drift that turns a query into an empty result looks like a speedup and still passes the budget. So every default-enforced `interactive_slo` read command makes one untimed call after seeding, before its Criterion loop, and asserts the result shape — exact where stable (requested id set, page length, seeded count), nonempty only where the result is intentionally variable. The timed loop may keep discarding its result.

Do not preflight a mutator against the measured fixture (it changes the advertised scale). Assert durable growth after `group.finish()` instead; `create_block` is the model — fixture at exactly 100K before timing, then block and op-log counts each grow by `Acc::iters()`.

Put the same probe on any non-SLO bench whose fixture can degrade into a cheaper shape (`bench_export_page_markdown` in `src-tauri/benches/groups/export_bench.rs` is the model); those run in the `--test` lane, so the check fires every week.

**Placement:** in the outer bench function's own body, after the seeder and outside every `bench_function` / `bench_with_input` / `iter_custom` closure. That body runs under both `--test` and a name filter, which is what makes the assertion load-bearing. Position relative to `c.benchmark_group(..)` does not matter — a parameterized group necessarily probes each fixture after opening the group.

## Seeding fixtures: the schema-drift checklist

Seeders use raw `sqlx::query(...)` and must match the live schema. Classes that have bitten:

- **`op_log.created_at` is `INTEGER` epoch-ms** (migration 0079) — bind an `i64`, not an RFC-3339 string; the STRICT table rejects TEXT.
- **Reserved property keys** `('todo_state','priority','due_date','scheduled_date','space')` are `blocks` columns; migration 0088's `key_not_reserved` CHECK rejects them in `block_properties`. Use a free-form key or set the column.
- **Space membership is `blocks.space_id`** (0086) with a `spaces` registry FK (0089): insert the owner block, `INSERT OR IGNORE INTO spaces (id) VALUES (?)`, then set `space_id`. Never seed a `'space'` property row. Canonical filter: `(?N IS NULL OR b.space_id = ?N)` (`src-tauri/agaric-store/src/space_filter_canonical.rs`).
- **Every `'page'` block needs `page_id = id`** (0073 CHECK). `INSERT OR IGNORE` silently drops a violating page row, which surfaces later as an FK error.
- **Ids passed to commands must be valid ULIDs** — 26 chars Crockford base32, no `I/L/O/U`. `SpaceId::from_trusted` skips validation; a command path does not.
- **`op_log.block_id`** must be set on rows feeding revert/undo — `find_prior_text` filters on the column, not on `json_extract(payload)`.

Fixing one class usually exposes the next; rerun `--test` until clean.

## Pre-commit

The `cargo fmt` pre-commit hook rewrites unformatted bench code in place and aborts the commit; re-stage and commit again. A `--check` companion runs at pre-push. Confirm HEAD advanced — under `rtk` a hook abort can look like success.

## Layout: themed binaries + `groups/`

Groups live verbatim in `src-tauri/benches/groups/<name>.rs` and are pulled into five themed binaries (`engine_bench`, `query_bench`, `agenda_bench`, `io_bench`, `core_bench`) via `#[path = "groups/<name>.rs"] mod <name>;` and one `criterion_main!` each — one link per theme instead of one per group. Every `benchmark_group` / `bench_function` / `BenchmarkId` string is unchanged, so baselines in `target/criterion/` (keyed by id) keep resolving.

Two benches stay standalone: `interactive_slo` (CI invokes it by name; never fold it in) and `loro_vs_sql_reads` (hand-rolled `fn main()`, not criterion).

Run one group by filtering its themed binary: `cargo bench --bench core_bench -- hash`. CI and the smoke loop enumerate `[[bench]]` names dynamically, so new themed binaries are picked up automatically.

## Seeders are duplicated per group, on purpose

Each `groups/*.rs` carries its own `fresh_pool`, `seed_*`, `ts_for`. Sibling mods in the same binary do not collide. When you change a seeding pattern, grep the sibling files and keep them in sync.
