# Session 1465 — the guards that earn their keep, and one premise that did not

Three items: #4556 Phase 1+5 (unwire the delete-set hooks, cap the population,
write the policy), #3667 (derive the mutation filer's child cap), and #3393
(measure per-package mutation test scoping). Two shipped. The third was
reverted, and the reason is the most useful thing in this session.

## #3393: the premise was wrong, and it was mine

I told #3393 that per-package test scoping was an unexploited ~18x lever, on
the strength of session-1268's "415 s/mutant in CI vs 38 s/mutant locally with
tests scoped to the package".

cargo-mutants has scoped tests to the mutated package **by default since
v24.11.0**. `TestPackages::Mutated` is the `#[default]` (`src/options.rs:208`),
resolution falls through to it with no flag and no config key (`:294-310`), and
`Mutated` becomes `PackageSelection::Explicit([mutant.source_file.package])`
(`src/lab.rs:342`), which `src/cargo.rs:139` renders as `--package=<name>@<ver>`.
Verified on 27.1.0 — the version CI installs, unpinned via `taiki-e/install-action`
— by source read, by the crate's own unit tests, and end-to-end by reading back
recorded argv from `outcomes.json` on a two-package fixture:

| invocation | per-mutant argv |
|---|---|
| no flag (default) | `--package=liba@0.1.0` |
| `--test-workspace=false` | `--package=liba@0.1.0` |
| `--test-workspace=true` | `--workspace` |

`src-tauri/.cargo/mutants.toml` sets neither `test_workspace` nor
`test_package`, so the lane is already on the default.

So the lane is not unscoped. `agaric-store` mutants already run
`--package=agaric-store`. The reason the lane is slow is that every mutant it
has ever reached lives in `src/reverse/**`, i.e. package `agaric`, whose suite
is nearly the whole workspace — because most `agaric-store`/`agaric-engine`
behaviour is still tested from the app crate. **The lever is #3120/#3299/#3443,
not a flag.**

Session 1268's 18x is confounded independently of this: its own table compares
a CI 4-vCPU runner against a local 8-core/16-thread Ryzen, so scope and hardware
vary together, and its headline ("98 mutants tested in 42m") implies 25.7
s/mutant rather than 38.

The measurement job built on that premise was also blocked by
`file-scheduled-failures.mjs --self-test` (3 assertions): every lane in
`scheduled-deep-checks.yml` must appear in the reporter's `needs`, but the job
is `workflow_dispatch`-only, so it is `skipped` on the cron — and
`isFailing('skipped')` is true, with the self-test explicitly forbidding
`--skipped-ok` on the schedule. Adding it would have opened the rolling
tracking issue every Monday, forever. Reverted rather than reworked: a
measurement job whose premise is refuted should not be reworked into shipping.

## #4556: two hooks the issue listed for deletion, and its own criteria kept

184 -> 156. Twenty-nine removed, one added. Every removed script stays on disk;
the revert is config-only.

The issue's DELETE list is wrong twice, and in both cases its own five criteria
are what catch it:

- **`bench-lane-coverage`** — #4556 lists it in group C and then says outright
  that deleting it "is the one place this proposal argues against its own §1".
  Recorded defect (#3362), fail-open-silent, 0.25s, tightly scoped.
- **`py-guard-file-source-selftest`** — listed in group B as a dev-workflow
  self-test whose "failure is immediately visible to the developer". It is not.
  `scripts/lib/guard_file_source.py` is the index-vs-working-tree resolver five
  KEEP-list guards load, and `prek.toml`'s own comments say in three places
  that with its `exists()` defanged those guards return rc=0 on a **real** `.rs`
  file, and that only this suite catches it (#4017). That is criterion 5 with a
  recorded incident.

Both kept. The pattern is worth naming: an issue that proposes deletions is not
a better authority on them than the criteria it proposes.

Zero hooks had a `# WHY:` line, so a presence-checking guard would have been
committed permanently red. 156 were authored from each hook's existing comment
block; review found 3 wrong, all the same claim imported verbatim from #4556's
own body (attributing a fail-open to `3a78544`/`7f523ed`, both of which touch
only `check-mutation-harness-clones.mjs`). Those three hooks were the only ones
in the file with no comment block to derive from — the error rate among the 112
that cite an issue was zero.

`scripts/check-hook-budget.mjs` has no self-test, deliberately, and says so in
three places. #4556's corollary that a guard needing its own guard is a smell
applies to this guard first.

## #3667: derive, do not re-pin

`DEFAULT_MAX_CHILDREN = 43` was documented as the measured area universe and
therefore unable to bite. The universe is 44. `43 = 21 + 22` was right on
2026-08-09; `op_log/high_water.rs` arrived 2026-08-16 in `fbdebb6a1` (#4016)
and made the rust half 23. Fourteen days, unnoticed, because the only
self-tests touching the cap pass `maxChildren: 1` and never constrained the
default.

Three review findings, each worth more than the fix:

1. A **static** import of the shared helpers broke
   `main-module-detection-selftest`, which copies this script alone to a
   detached path and asserts exit 0. That hook is keyed on this very file, so
   it would have failed on this commit. Lazy `await import()` instead.
2. The self-test did not discriminate. Both halves shared
   `MUTANTS_WORKSPACE_DIR`; repointing it collapsed the rust half to 0 and the
   assertion still passed at `frontend 21 + rust 0 = 21` — the cap silently
   halved while the test agreed with itself. Each half must now be non-zero in
   its own right.
3. The fallback was 44, i.e. today's universe — which reproduces this issue one
   branch over. Now 150. Not `Infinity`: that deletes the fragmentation
   backstop on precisely the degraded path.

## The pattern across all three

Eight agents ran across the audit and build phases. Every one produced accurate
measurements — numbers reproduced to the digit, several to the millisecond.
Every error was in an **inference** drawn from a correct number: session-1268's
confounded 18x, my own reading of it, the self-test that agreed with itself, a
fallback pinned to a number that will move.

That is the same failure #4556 is about, one level up: a confident claim from
something that could not see what it was claiming about.
