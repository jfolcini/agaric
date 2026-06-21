# Benches — orientation, pitfalls, and the rules for keeping them green

Criterion benches under `src-tauri/benches/`. They measure perf AND, for
`interactive_slo`, enforce the product SLO (≤200 ms p95 @ 100K blocks; see
`docs/architecture/operations.md` § Product SLO).

## CI runs every bench: a `--test` smoke gate + the `interactive_slo` perf gate

`scheduled-deep-checks.yml`'s `bench-compile` lane does, in order:

1. `cargo bench --no-run` — compiles every bench (catches compile bit-rot).
2. **#978 seed/fixture smoke gate** — runs EVERY bench once with `--test`
   (criterion's single-shot, no-measurement mode). A bench whose hand-seeded
   raw-SQL fixture has drifted from the live schema **panics here and fails the
   job** instead of rotting silently. This validates SEEDS/FIXTURES, not perf.
3. `cargo bench --bench interactive_slo` — the WARM perf gate (the only bench
   with a timing budget; `interactive_slo` is excluded from the cold `--test`
   smoke loop so its `assert_under_budget` isn't tripped by cold timings).

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

A non-zero exit / `panicked at` is a real seed/fixture failure. Heads-up: the
heavy 100K-seed benches (e.g. `cache_bench`) are SLOW under cold `--test` (no
warmup — 10×+ inflation, see the COLD-timings note below); that's expected, not
a hang. To smoke just one bench, run a single `"$bin" --test`.

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
for f in commands_bench history_bench …; do
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

Benches that genuinely exceed their budget go to the **problem tier**: add
`if problem_skipped("<name> @ 100K") { return }` (see `interactive_slo.rs`'s
`problem_skipped` + `list_page_links` / `list_projected_agenda` /
`revert_ops_50op`), which skips them unless `SLO_INCLUDE_PROBLEM=1`. Measure
warm before gating — don't gate on a cold `--test` shot.

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

`cargo fmt --check` runs in pre-commit and will **abort the commit** (HEAD does
not move) if bench code isn't formatted. Run `cargo fmt` first. Verify HEAD
actually advanced after committing — a masked hook abort looks like success
under `rtk`.

## Cross-bench helpers are DUPLICATED, on purpose

Each `[[bench]]` is its own crate root, so seeders (`fresh_pool`, `seed_*`,
`ts_for`) are copy-pasted across files rather than shared. If you change a
seeding pattern, grep the sibling benches and keep them in sync.
