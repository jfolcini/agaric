## Session 1141 — #2122: parallelize the nightly bench-compile smoke-run loop (2026-06-30)

| Field   | Value                                          |
| ------- | ---------------------------------------------- |
| Session | 1141                                           |
| Issue   | #2122                                          |
| Branch  | claude/issue-2122-bench-smoke-parallel         |
| Date    | 2026-06-30                                      |
| Area    | .github/workflows/scheduled-deep-checks.yml    |

## Summary

The `bench-compile` job in the nightly *Scheduled deep checks* lane was failing
by exceeding its 90-minute `timeout-minutes`. Pulling the step timings from the
last run (run 28360914915, 2026-06-29) pinpointed the cause:

- Step "Compile all bench targets (no-run)": **~31.5 min** (bounded).
- Step "Smoke-run every bench once (--test)": **~57.5 min and still running**
  when the 90-min job timeout cancelled it.

So the runaway is the **#978 smoke-run loop**, not compilation. The loop runs
all 25 prebuilt bench binaries (every `[[bench]]` except `interactive_slo`)
**sequentially**, each as a cold `--test` single shot; the heavy 100K-seed
benches dominate and the cumulative wall-clock blows the budget.

## Change

Parallelize the smoke-run loop with **bounded concurrency** (`.github/workflows/
scheduled-deep-checks.yml`). Each bench is a prebuilt binary (compiled once by
the `--no-run` step), so concurrent execution is safe — there is no per-bench
recompile, so the cargo #6313 link race that the prebuilt-binary approach
deliberately avoids is unaffected by running the binaries at once. The loop now
backgrounds each `smoke_one` with a `wait -n` gate capping concurrency at
`min(nproc, 3)` (3 on the standard runner) — enough to cut wall-clock ~3× while
keeping peak memory sane on the 100K-seed benches. Each bench records its
pass/fail verdict in a per-bench status file (a backgrounded subshell can't
mutate the parent's `fail`), which is reduced after `wait` to produce the job's
exit code. The seed/fixture-drift guarantee (#978), the `interactive_slo` skip
(warm-gated separately), and the per-bench `::group::`/`::error::` annotations
are all preserved.

Expected wall-clock: compile ~31 min + smoke ~20 min ≈ ~51 min, comfortably
under the (unchanged) 90-min budget.

## Verification

- `shellcheck -s bash` on the extracted run-block script — clean (no warnings).
- `bash -n` syntax check — clean.
- Functional test of the concurrency gate + failure aggregation with stubbed
  benches: all inputs processed, an injected failure propagates to `exit 1`,
  the `wait -n` gate bounds concurrency.
- Wall-clock improvement is confirmable only on the nightly lane (the full bench
  suite is not runnable in the dev sandbox); the `timeout-minutes` is left at 90
  so a regression still surfaces as a timeout rather than being masked.
