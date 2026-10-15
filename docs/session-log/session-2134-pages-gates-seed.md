# Session 2134 — The Pages perf gates seed in linear time again

Main's weekly `bench-slo` lane was cancelled on #5578's branch, and would be
on main now that #5578 has merged. Its interactive probes all passed (the
`Notes/*` namespace probe went from 41 ms to 0.69 ms). The step after them,
`cargo nextest run --run-ignored=only`, timed out instead: all four
`*_perf_gate_20k_pages` tests in `list_pages_with_metadata_tests` hit
nextest's 2x30s kill on every try, and the job ran out of time.

The cause is a test helper #5578 added. `sync_pages_cache_space`
(`src/commands/tests/common.rs`) runs on every `seed_page`. It filtered
with `WHERE ?1 IS NULL OR page_id = ?1`, which SQLite cannot answer from
the primary key, so each seeded page scanned the whole cache. Seeding 20k
pages became quadratic.

Production is not affected. `cache::sync_pages_cache_space_ids` reads by
`page_id IN (SELECT value FROM json_each(?))`, and no other query has that
shape. The helper now runs one of two statements: keyed by `page_id`, or
over all rows.

Measured on this box, debug build:

| Gate | Main before #5578: seed, median | #5578 head | This branch: seed, median |
| --- | --- | --- | --- |
| filtered (orphan + tag) | 26.2 s, 44 ms | killed at 60 s while seeding | 31.8 s, 45 ms |
| Most linked | 22.5 s, 35 ms | killed at 60 s while seeding | 30.8 s, 30 ms |
| Recently modified | 30.2 s, 46 ms | killed at 60 s while seeding | 44.0 s, 38 ms |
| Created and alphabetical | failed its assertion | killed at 60 s while seeding | passes |

Seeding is still slower than before #5578, because every insert also
maintains the per-sort indexes. Main's last weekly CI run took about 1.3
to 1.7 times this box's time, which puts Recently modified past 60 s. The
gates therefore get the 4x30s leash the scale sweeps already have. The 30 s
SLOW flag still fires; only the kill moves.

Correction to session 2120. It merged saying the lane's pages, glob and
conformance tests, its three falsifications and clippy were still to run.
They ran at #5578's head:

- **Tests:** 499 of 499 passed.
- **Falsifications:** F1, F2 and F3 each failed
  `page_list_filters_seek_their_pages_instead_of_walking_the_space` on the
  predicted line.
- **Clippy:** clean.

Ran on this branch:

- the four perf gates with `--no-capture` (the table above);
- every `/pages/` and `/space/` test: 748 passed;
- `cargo clippy --workspace --all-targets -- -D warnings`;
- `taplo fmt --check` on the nextest config.
