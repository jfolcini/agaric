# Session 2583 — a committed report of CI slots, queue wait and cache hits

**Gap:** #5853 asks to re-measure CI after each change to what it runs or
caches, and nothing committed could: the slot, queue-wait and cache-hit
numbers so far came from ad hoc `gh` loops.

**`scripts/ci-capacity-report.mjs`** reports over a window: peak jobs running
and waiting at one instant; queue wait (median, p90 and max of
`started_at - created_at`) per event; per cache key, restore hit/partial/miss
on PR and main runs, read from job logs; and the live cache entries. Usage is
in its header and in `docs/architecture/ci-and-tooling.md` § Measuring runner
slots and caches.

The first runs were wrong, and each correction is in the code:
- A queued job carries `started_at` too, so a job counts as running only once
  it has a `runner_name`.
- The runs list shifts while paging, so runs are deduplicated by id.
- A re-run copies the jobs it reuses under new ids with the original runner
  and times. Jobs are deduplicated by runner and start time, keeping the
  lowest id, the one whose log exists.

Over 04:57–13:57Z on 2026-10-18 (659 runs): peak running 20, exactly the
plan's cap; peak waiting 54 at 05:45Z. Queue wait 0.3 / 4.7 / 19.0 min
(median / p90 / max) on PRs, 0.6 / 15.1 / 32.2 min on main.

A full report costs about one API request per run plus one per log. Three
full runs and two debug passes used up the account's 5,000-an-hour budget, so
the default window is 6h and the header states the cost.
`scripts/ci-capacity-report.test.mjs` (in `lint`'s `node --test` list) covers
the log parser, key families, percentile, overlap and `--since`; two mutants
were killed (hit/partial swapped, the end-before-start tie-break reversed).

**Built, then held back: #5847's lint split and build-once test archive.** A
`lint-rust` matrix (clippy, fuzz, sqlx) and a `cargo-tests-build` job that
archives the instrumented test binaries for three shards were built and
checked on a scratch workspace. On a warm cache neither earns its keep:
`lint` (9.3 min on main run 39130341368) is not the long pole beside the
11.7–12 min `cargo-tests` shards, the split costs about 8 more slot-minutes
per backend run, and the archive's critical path comes out at 11.5–12.5 min.
Both win only on a cold cache, which the cache work in #5853 targets first.
Re-measure with this report after that lands, then decide.
