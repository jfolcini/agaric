# Session 1233 — Bench crate consolidation (#2879)

**Issue:** #2879

## What

The 30 single-`criterion_main!` bench crates each linked `agaric_lib` +
criterion as a separate crate, multiplying link work under `cargo bench` and
pre-push `--all-targets` clippy. Consolidated into 5 themed binaries
(`engine_bench`, `core_bench`, `io_bench`, `query_bench`, `agenda_bench`);
each former bench file lives verbatim in `benches/groups/<name>.rs` pulled in
as a `#[path] mod`.

- Every criterion `benchmark_group`/`bench_function` id string UNCHANGED —
  historical baselines in the shared `target/criterion/` tree (keyed by id,
  not binary) keep resolving.
- `interactive_slo` stays standalone (invoked by name by the CI SLO perf
  gate — must not change); `loro_vs_sql_reads` stays standalone (hand-rolled
  `fn main()`, not criterion).
- The CI deep-check shard job enumerates `[[bench]]` names dynamically, so it
  shards fewer, larger targets; coverage preserved (each themed binary's
  `--test` smoke run exercises every group it owns).
- `benches/AGENTS.md` + architecture doc updated.

## Verification (honest status)

- `SQLX_OFFLINE=true cargo check --benches` clean (all 7 targets type-check).
- The full `cargo bench --no-run` release build (thin-LTO, codegen-units=1)
  and the before/after wall-clock measurement were CUT SHORT by session
  wind-down (~2.5h into the release graph, user requested stop). CI's bench
  compile lane is the release-compile arbiter; the measured before/after
  timing comparison is deferred — no numbers are claimed.
- Adversarial review deferred to the PR's agaric-reviewer + CI (mechanical
  file moves with id-preservation as the invariant).

## Wind-down note

Shipped as the session's last item on maintainer instruction ("push your last
job and stop"). If CI reds on a bench target, the fix belongs to whoever picks
up #2879 next.
