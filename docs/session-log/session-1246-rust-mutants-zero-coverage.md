# Session 1246 — the Rust mutation lane never measured anything

Single-issue session, 2026-08-01. #3386: the `mutants` job in
`scheduled-deep-checks.yml` had failed 4 of its last 5 scheduled runs on its own
zero-coverage guard (#3057). The guard was right. The lane was producing
`total_mutants: 0`.

The interesting part is not that it was broken. It is that it had *always* been
broken, in three independent ways, each of which is silent by construction, and
that the one "success" in the five-run window was a false green.

## What the evidence said

The failing runs still had their `mutants-out` artifact, which is where the
answer was — `gh run view --log-failed` returned an empty body, but
`gh run download <id> -n mutants-out` did not.

`outcomes.json` from the 2026-07-29 run:

```
"scenario": "Baseline", "summary": "Failure",
  Build 325s Success,  Test 678s Failure(101)
  argv: cargo test --verbose --package=agaric@0.9.2
total_mutants: 0
```

Two things fall out of that one blob. First, `cargo test` — not
`cargo nextest run`, though `mutants.toml` said `test_tool = "nextest"`. Second,
`mutants.json` in the same artifact was 13.6 MB listing 3192 mutants across
`src/commands/**`, `src/db/**`, `src/link_metadata/**` — the whole crate, though
`mutants.toml` restricted `examine_globs` to four invariant-core paths.

Neither setting was in effect. cargo-mutants reads its configuration from
`<workspace-root>/.cargo/mutants.toml` and nowhere else
(`Config::read_tree_config`, sourcefrog/cargo-mutants `src/config.rs`); when the
file is absent it logs `No config found in workspace` at **debug** level and
proceeds with `Config::default()`. The repo's file was at
`src-tauri/mutants.toml` — where it had been since #866, the commit that
introduced the lane. It was never read. Not once.

The five baseline test failures follow directly: four `mcp::tools_ro::tests::*`
failing with `unable to open database file` and the B4 reproject proptest taking
the SQL-only fallback. All five are artifacts of `cargo test`'s
one-process/many-threads model. `cargo nextest run -p agaric` — measured here —
is 3383 passed, 0 failed, 123s. So the *ignored* `test_tool = "nextest"` was
also the thing that would have made the baseline pass, and a failed baseline is
exactly what produces `total_mutants: 0`.

The 2026-07-20 "success" had `total_mutants: 0` and `"summary": "Timeout"` too.
It only reads as green because the zero-coverage guard landed on 2026-07-23. The
lane's entire green history is `cargo mutants ... || true`.

## Bug two: the globs pointed somewhere the lane could not reach

Fixing the path was not enough. `cargo mutants --list` with the config finally
being read: **137 mutants**, all in `src/reverse/**`. Three of the four
`examine_globs` contributed nothing.

They point into `agaric-store` and `agaric-engine`, where the #2621 arch waves
(S2, S3b-ii, E1) moved `op.rs`, `op_log/` and `loro/engine/`. The globs *were*
dutifully repointed at the time, and the paths *do* exist on disk. But
cargo-mutants only generates mutants in the packages it examines, and this
workspace's root manifest is itself the `agaric` package with no
`default-members` (#3212 documents that same footgun for `cargo check`), so a
bare `cargo mutants` examines `agaric` alone. `--list --workspace`: **607
mutants**. The lane had silently lost 78% of its declared surface, and every
path in the config still resolved.

This is the part worth remembering: a path-existence guard of the
`check-stryker-modules.mjs` shape — the obvious thing to reach for, and what
#3330 added for the frontend lane — would have passed cleanly through this.

## Bug three: every reader was one directory short

`-o/--output DIR` creates `DIR/mutants.out`; it does not write *into* `DIR`. The
workflow passed `--output mutants-out` and then had the zero-coverage guard, the
step summary and the `file-mutation-survivors` filer all read `mutants-out/…`.
Those paths never existed. Even a perfectly healthy run would have reported no
coverage and no survivors — and that is the direct cause of the #3387 blockage,
where `--require-rust` throws on an absent `missed.txt`.

So the lane had two independent guarantees of failure stacked on one guarantee
of measuring the wrong thing.

## What shipped

- `src-tauri/mutants.toml` → `src-tauri/.cargo/mutants.toml`.
- `--workspace` on the invocation, so all four globs are live.
- `--output` dropped; guard, summary and artifact upload repointed at
  `src-tauri/mutants.out/`. The upload now ships cargo-mutants' output directory
  *itself*, so the filer's flat `mutants-artifact/missed.txt` resolves.
- A wall-clock budget (`timeout --signal=INT`, 90 min of the job's 120). 607
  mutants do not fit: measured locally, a mutant costs ~26s in `agaric-store`
  and 13–35s in `agaric` on 16 cores, cargo-mutants runs them sequentially by
  default, and the runner has 4 vCPUs. Without a budget the job would be
  CANCELLED at 120 minutes and the guard step would never run — red again, for a
  brand-new reason. SIGINT instead makes cargo-mutants write partial
  `outcomes.json` / `missed.txt` with the baseline still recorded as `Success`,
  so every path the later steps read is present and honest. Order is
  deterministic, so a truncated run covers a stable prefix and the survivor
  filer's cross-run diff does not churn.
- The guard and summary now print tested-of-generated, so truncation is stated
  rather than inferred.

### Review corrections to the above

- **Tree restoration on SIGINT is not guaranteed.** Measured on cargo-mutants
  27.1.0: 12 of 13 SIGINT'd runs left `git status` clean, one left a mutant
  written into the source file. Harmless on an ephemeral runner, but a local
  `--in-place` reproduction must check `git status` afterwards — the stray
  mutant lands in a *tracked* file, where `.gitignore` cannot help.
- **`--in-place` also leaves proptest seed files behind, every time.** A mutant
  caught by a proptest makes proptest write
  `<pkg>/proptest-regressions/<mod>.txt` recording a case that only fails
  *because a mutant was applied*. cargo-mutants restores the source it mutated
  and knows nothing about these. They are deliberately **not** gitignored (the
  repo tracks six real ones), so after a local run they show up as new untracked
  files that look like genuine regressions. Delete them; do not commit them.
- **The budget does not truncate proportionally — it truncates by package.**
  The mutant list is ordered `src/reverse` 1–137, `agaric-engine/src/loro`
  138–509, `agaric-store` 510–607. Measured cost is ~26.5s/mutant on 16 cores
  (2 mutants in 78s including a 25s baseline), so reaching position 510 needs
  ~3.75 h — against a 90-minute budget, on hardware faster than the 4-vCPU
  runner. `agaric-store` (op.rs / op_log — the hash-chain core this lane exists
  for) is therefore never mutated, in any run, indefinitely. "tested: N of 607"
  reads as a proportional sample and hides that, so the summary now prints the
  per-package split, which renders the blind spot as
  `agaric-store: 0 of 98  <-- NOT COVERED`. Right-sizing (rotating `--shard`,
  `--jobs > 1`, or narrower globs) remains a separate decision — note that a
  rotating shard would interact with the survivor filer's cross-run diff.
- `scripts/check-mutants-scope.mjs` + two prek hooks + a gating vitest suite.

## The guard

It checks the three things above, statically, with no cargo invocation: the
config is at the one path cargo-mutants reads (and no stray copy sits at the old
one); every `examine_glob` matches at least one `.rs` file that is *reachable
from the package set the lane actually examines*; and every path the lane's own
steps read matches where the invocation will write.

The reachability check is the one that matters, and it nearly shipped vacuous.
The first draft treated the `.` member (the root manifest's own package) as
matching every path, which made `agaric-store/src/op.rs` "reachable" from an
invocation that never mutates `agaric-store` — the exact bug, waved through by
the guard written to catch it. The self-test caught it on first run. `.` owns
what is *not* inside another member's directory, and the self-test now asserts
both directions so it cannot regress to a wildcard.

Break-tests, all red:

- drop `--workspace` → 3 × `glob-outside-examined-packages`, naming the files.
- restore `--output mutants-out` → `output-path-mismatch` per reader plus
  `artifact-path-mismatch`.
- move the config back to `src-tauri/mutants.toml` → `config-missing`; leave a
  copy at both paths → `config-stray`.

## Proof the lane measures again

`cargo mutants --in-place --workspace --timeout 900 --build-timeout 600
--shard 0/120` under the shipped `timeout --signal=INT` wrapper:

```
Found 6 mutants to test
ok       Unmutated baseline
6 mutants tested: 2 caught, 4 unviable
```

and the shipped guard shell against that output:

```
zero-coverage guard OK: total_mutants=6 baseline=Success
```

Baseline `Success` where it was `Failure(101)`; `total_mutants` 6 where it was
0; `missed.txt` at the artifact root where the filer reads it.

## Left open

The full 607-mutant surface does not fit in one weekly job — the budget will
truncate, and the run will cover a deterministic prefix rather than the whole
invariant core. Right-sizing that (a shard matrix, or `--jobs` above
cargo-mutants' default of 1, which was left alone here because concurrent cargo
jobs on a 4-vCPU runner is how this repo has historically hit OOM) is a separate
decision, now that the lane is healthy enough to be worth sizing.

Also noted, not fixed: `--in-place` means a mutant that breaks a proptest leaves
a `proptest-regressions/*.txt` seed behind in the source tree. Harmless on an
ephemeral runner and harmless if replayed (the seed only fails under mutation),
but it will surprise someone running the lane locally.
