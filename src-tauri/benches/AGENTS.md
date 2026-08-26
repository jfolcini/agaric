# Benches — orientation, pitfalls, and the rules for keeping them green

Criterion benches under `src-tauri/benches/`. They measure perf and, for
`interactive_slo`, enforce accumulated mean latency under command-specific
budgets at 100K blocks. The product target is ≤200 ms p95, but the current
batched harness does not directly measure or enforce per-call p95; see
`docs/architecture/operations.md` § Product SLO.

## CI runs every bench: a `--test` smoke gate + the `interactive_slo` perf gate

`scheduled-deep-checks.yml` (weekly + manual dispatch, not a per-PR gate) carries
two bench lanes:

- **`bench-smoke`** — sharded across several runners. Each shard compiles only
  its slice (`cargo bench --no-run --bench …`), then **smoke-runs that slice once
  with `--test`** (criterion's single-shot, no-measurement mode). A bench whose
  hand-seeded raw-SQL fixture has drifted from the live schema **panics here and
  fails the job** instead of rotting silently. This validates SEEDS/FIXTURES, not
  perf. (#639/#978; sharded in #2122 after the old single-runner `bench-compile`
  job blew the 90 min cap mid-smoke.)
- **`bench-slo`** — runs `interactive_slo` (the WARM mean-budget perf gate —
  the only bench with timing budgets) plus the `#[ignore]`d 20k-row perf gates.
  Split out of the smoke shards so a smoke timeout can never skip the SLO gate.
  `interactive_slo` is excluded from the cold `--test` smoke loop so its
  `assert_under_budget` isn't tripped by cold timings. A `workflow_dispatch`
  input (`slo_include_problem`) also measures the cache/counterfactual probes.

**History:** before #978 only `interactive_slo` actually RAN; every other bench
was compile-only, so it could be false-green — it compiled but panicked the
moment it ran, because the fixtures drifted from the schema and `--no-run` never
executed them (#1233 — the whole suite had drifted; #1234 fixed `interactive_slo`).
**`cargo check`/`--no-run` is NOT verification for a bench — you must RUN it**;
the #978 smoke gate is how CI now does that for the whole suite.

### Run the smoke gate locally before pushing

Mirror exactly what CI does — build once, then run each prebuilt binary with
`--test` (this dodges the cargo #6313 build-race; see next section):

```bash
cd src-tauri
cargo bench --no-run                                  # one cohesive build
for name in $(grep -A1 '^\[\[bench\]\]' Cargo.toml \
    | sed -n 's/^name = "\(.*\)"/\1/p' | grep -vx interactive_slo); do
  bin=$(ls -t "target/release/deps/${name}-"* | grep -vE '\.(d|so|dwp)$' | head -1)
  echo "smoke $name"; "$bin" --test || { echo "FAILED: $name"; break; }
done
```

A non-zero exit / `panicked at` is a real seed/fixture failure. Heads-up: a
themed binary that owns heavy 100K-seed groups (e.g. `core_bench`, which owns
the former `cache_bench`) is SLOW under cold `--test` (no warmup — 10×+
inflation, see the COLD-timings note below), and now runs ALL its groups in one
shot; that's expected, not a hang. To smoke just one group, filter:
`"$bin" --test cache` (or `cargo bench --bench core_bench -- --test cache`).

## How to RUN/verify a bench reliably (avoid the E0308 flake)

Running `cargo bench --bench <name> -- --test` repeatedly will intermittently
fail to compile with:

```
error[E0308]: mismatched types ... expected `Pool<Sqlite>`, found a different `Pool<Sqlite>`
note: there are multiple different versions of crate `sqlx_core` ...
warning: output filename collision at .../libagaric_lib.rlib
```

This is **not your code** — it's cargo issue **#6313**. `agaric`'s `[lib]` has
multiple crate-types (`cdylib`/`staticlib` for the Tauri app + `lib` for
tests/benches); under `cargo bench` they race to write the same
`target/release/deps/libagaric_lib.*` filenames, and a bench can end up linked
against a different `sqlx` instance → two `Pool<Sqlite>` types. It's a
**nondeterministic parallel-build race**, and incremental per-`--bench`
recompiles re-roll the dice (~50% loss). Do NOT "fix" the bench — it's fine.

**Reliable recipe — build once, then run the prebuilt binaries (no recompile,
no race):**

```bash
cd src-tauri
cargo bench --no-run                 # one cohesive build resolves consistently
for f in engine_bench query_bench agenda_bench io_bench core_bench; do
  bin=$(ls -t target/release/deps/${f}-* | grep -vE '\.(d|so|dwp)$' | head -1)
  "$bin" --test                      # criterion --test = run each bench once, no measurement
done
```

`--test` is a smoke run (each bench once); a non-zero exit / `panicked at` is a
real failure. If `--no-run` itself flakes on the collision, just re-run it.

## --test timings are COLD; budgets need a WARM run

`--test` runs each bench function ONCE (a cold single shot). For light benches
that's fine, but for heavy ones it inflates the time 10×+ — so a
`assert_under_budget` failure under `--test` may be a cold artifact, not a real
regression. To decide whether a bench truly exceeds its budget, do a full warm
measurement: `cargo bench --bench <name>` (criterion's `sample_size(10)` warm
loop). Only gate on the warm number.

Confirmable problem/counterfactual probes use
`if problem_skipped("<name> @ 100K") { return }`; the current examples are the
#2508 cache direct-query and #2585 MostLinked probes, enabled together by
`SLO_INCLUDE_PROBLEM=1`. The permanently over-budget revert probe has its own
`SLO_INCLUDE_REVERT=1` gate and does not ride that shared flag. Measure warm
before gating — don't gate on a cold `--test` shot.

## `interactive_slo` probes must observe results outside timing (#3304)

Every default-enforced read command must make one call after seeding and before
registering its Criterion loop, then assert the fixture/result shape. Prefer
exact stable expectations (requested id sets, page lengths, seeded counts,
serialized child count, production caps); use a nonempty check only when the
production result is intentionally variable. Keep this call outside
`iter_custom` so validation adds no timing cost. The timed loop may continue to
discard its result after this untimed assertion has pinned the exact scope and
filter branch it invokes.

Do **not** preflight a mutating command against the measured fixture: that
changes its advertised scale and state. For mutators, capture/validate outside
the elapsed region or assert exact durable state growth after `group.finish()`.
`create_block` is the model: the fixture stays at exactly 100K before timing,
then block and op-log counts must each grow by `Acc::iters()`.

This is load-bearing fixture coverage: a filter/schema drift that turns a query
into an empty result otherwise looks like a speedup and still passes the mean
budget. The assertions execute when the relevant prebuilt Criterion binary is
run by the scheduled, unfiltered warm lane. A compile-only check cannot
exercise them. The current Criterion harness has no safe focused runtime path:
a filter suppresses unmatched `bench_function` loops but still invokes their
outer functions, whose zero-iteration budget assertions then panic. A full cold
`interactive_slo --test` is likewise unsuitable for a budget verdict for the
reasons above.

The same probe belongs on any *non-SLO* bench whose fixture can degrade into a
cheaper shape — there it is strictly better off, because those benches DO run in
the `bench-smoke` `--test` lane, so the assertion is checked every scheduled run
rather than only in the warm lane. `export_bench.rs::bench_export_page_markdown`
is the model: the same `page_id` drift that silently reduced the SLO export
probe to a heading-only page had reduced this bench too, and neither reported
anything but a faster number. Because a shape probe is untimed and outside
`iter_custom`, cold `--test` timings are irrelevant to it.

**Where the probe goes:** in the outer bench function's own body, after the
seeder that builds the fixture it inspects and outside every
`bench_function`/`bench_with_input`/`iter_custom` closure. That body is what
Criterion runs unconditionally — both `--test` and a name filter still invoke
it — and *that* is what makes the assertion load-bearing. Its position relative
to `c.benchmark_group(..)` is irrelevant and must not be read as the rule: a
parameterized group cannot satisfy "before `benchmark_group`" at all, because it
opens one group and then seeds a fixture per parameter inside the loop. The
model bench is exactly that case — `bench_export_page_markdown` probes each
`n_blocks` fixture *after* `benchmark_group` and before that parameter's
`bench_with_input`, which is correct. The `interactive_slo` probes precede their
group only because they seed a single fixture up front; that is a consequence of
their shape, not a placement rule (#3441).

## Seeding fixtures: match the CURRENT schema (the drift checklist)

Benches hand-seed via raw `sqlx::query(...)`. When you add/copy a seeder, it
MUST match the live schema or it panics at runtime. The classes that have bitten
us (each is a real migration):

- **`op_log.created_at` is `INTEGER` epoch-ms** (migration 0079, #109 Phase 2) —
  bind an `i64` (e.g. a base + monotonic offset), NOT an RFC-3339 string. The
  STRICT table rejects TEXT. (The root `AGENTS.md` §Database note correctly
  reflects that 0079 (#109 Phase 2) migrated this column to INTEGER epoch-ms.)
- **Reserved property keys** `('todo_state','priority','due_date','scheduled_date','space')`
  are column-backed on `blocks`; migration 0088's `key_not_reserved` CHECK
  FORBIDS them in `block_properties`. Use a free-form key, or set the dedicated
  `blocks` column.
- **Space membership is `blocks.space_id`** (0086) + the **`spaces` registry FK**
  (0089): insert the owner block, then `INSERT OR IGNORE INTO spaces (id) VALUES (?)`,
  then set `space_id`. Do NOT seed a `'space'` property row. The canonical filter
  is `(?N IS NULL OR b.space_id = ?N)` (`space_filter_canonical.rs`).
- **Every `'page'` block needs `page_id = id`** — migration 0073's
  `page_id_self_for_pages` CHECK. `INSERT OR IGNORE` will SILENTLY DROP a page
  row that violates this, which then surfaces downstream as a confusing FK error.
- **Ids parsed as ULIDs** (passed to commands like `export_page_markdown_inner`)
  must be valid Crockford base32 — 26 chars, no `I/L/O/U`. `SpaceId::from_trusted`
  bypasses validation; a raw command path does not.
- **`op_log.block_id`** (indexed column, migration 0030) must be set on op_log
  rows feeding the revert/undo path — `find_prior_text` filters on that column,
  not on `json_extract(payload)`. Unset → NULL → "no prior text found".

When fixing one class, expect the next to surface on the next run (created_at →
reserved keys → page_id → spaces FK → ULID → block_id). Re-run until clean.

## Pre-commit

The `cargo fmt` pre-commit hook **auto-formats** (`cargo fmt --all`, #817) rather
than checking: it rewrites unformatted bench code in place and then **aborts the
commit** (HEAD does not move) so you re-stage. Re-stage and commit again — you do
not need to run `cargo fmt` by hand. A `--check` companion runs at pre-push.
Verify HEAD actually advanced after committing — a masked hook abort looks like
success under `rtk`.

## Layout: themed binaries + `groups/` mods (#2879)

The former single-`criterion_main!` bench crates were consolidated into a
handful of **themed bench binaries** (`engine_bench`, `query_bench`,
`agenda_bench`, `io_bench`, `core_bench`) to cut Rust build/link time — each
`[[bench]]` used to be a separate crate linking `agaric_lib` + criterion, and
that link multiplier is the pre-push/`--all-targets` long pole. The former bench
files now live **verbatim** in `benches/groups/<name>.rs` and are pulled into
their themed wrapper as `#[path = "groups/<name>.rs"] mod <name>;`; the wrapper
is a thin file whose single `criterion_main!(...)` re-exports every group. Only
each file's own `criterion_main!` + the `criterion_main` import were dropped in
the move — **every `benchmark_group`/`bench_function`/`BenchmarkId` id string is
unchanged**, so historical criterion baselines in the shared `target/criterion/`
tree (keyed by id, not by binary) keep resolving. Files in `benches/groups/` are
NOT top-level, so cargo auto-discovery does not turn them into stray targets.

**Two benches stay standalone binaries:** `interactive_slo` (CI invokes it by
name for the perf/SLO gate — never fold it in) and `loro_vs_sql_reads` (a
hand-rolled `fn main()` harness, not criterion — it can't join a
`criterion_main!`).

To run one former bench, run its themed binary and filter by id, e.g.
`cargo bench --bench core_bench -- hash` or
`cargo bench --bench engine_bench -- engine_checkpoint`. The CI shard job and
the local smoke loop enumerate `[[bench]]` names dynamically, so they pick up
the new names automatically; a themed binary's `--test` run exercises EVERY
group it owns, preserving the #978 fixture coverage.

## Cross-bench helpers are DUPLICATED, on purpose

Each former bench file (now a `mod` under `groups/`) still carries its own copy
of the seeders (`fresh_pool`, `seed_*`, `ts_for`) rather than sharing them —
they were copy-pasted when the benches were separate crates and remain
per-`mod`. Because each file is a distinct module, identically-named helpers in
sibling mods of the SAME themed binary do NOT collide. If you change a seeding
pattern, grep the sibling `groups/*.rs` files and keep them in sync.
