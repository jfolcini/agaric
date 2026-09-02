# Session 1482 — Fuzz budget from 120 s to 300 s per target

The weekly fuzz lane gave each of its eight cargo-fuzz targets 120 seconds: sixteen minutes of fuzzing a week, restarted from the seed corpus every time until #4529 made the corpus persist across runs. With persistence in place the budget is the only lever left, and 120 seconds is a smoke length, as the lane's own comment says.

This session raises the per-target default to 300 seconds, everywhere the number lives: the dispatch input's default, both `env:` fallbacks (the fuzz step and the scheduled-failures reporter), the reporter's guard that compares a dispatch's inputs against the declared defaults, and the fuzz job's `timeout-minutes` (130 to 155, re-derived from the job's own worst-case arithmetic, which is updated in place). The cmin step's bound is unchanged.

Not changed: the Stryker lane. A local measurement earlier today counted 42 timeouts in the date-utils lane and read them as hidden survivors; the same lane's CI report from 2026-08-31 has none, and across all 21 lanes the 64 CI timeouts are hit-limit ones, where a mutant loops past a hundred times its dry-run count. Those are honest kills. The local figure was CPU contention from a cargo build sharing the box, so there is nothing to tune in Stryker's config.

Verified: the workflow-lint and zizmor pre-commit hooks on the changed file; the numbers were cross-checked by grepping every `120` and `130` tied to the fuzz lane.
