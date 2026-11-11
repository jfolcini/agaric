# Session 3852 — CI: flaky nextest tests named, full suite and Android launch nightly

The first two items of #6553. The retries-off and Android emulator items are not part of this.

## What changed

- **Flaky tests have names.** `profile.ci` in `src-tauri/.config/nextest.toml` writes a JUnit report to `target/nextest/ci/junit.xml`. All three CI nextest runs (`cargo-tests` shards, `mcp-tests`, `full-suite-nextest` shards) run `scripts/nextest-flaky-report.mjs` on it, which lists every test with a `<flakyFailure>` or `<flakyError>` (failed an attempt, then passed) in the job summary, and upload the XML for 30 days. A flaky test does not fail the job; a missing or truncated report does. The OPEN QUESTION in `nextest.toml` now cites #6553, since #3959 is closed.
- **`full-suite` and `android-launch` run nightly.** `scheduled-deep-checks.yml` has a second cron, `17 4 * * 0,2-6` (every day but Monday), held in `NIGHTLY_CRON` with its lanes in `NIGHTLY_LANES`. `select-lanes` picks lanes from the cron that fired and fails on a cron it does not know. Monday still runs every lane.
- **The failure reporter judges only what ran.** `file-scheduled-failures.mjs --scope` judges the listed jobs. Every other lane the issue tracks stays tracked, and the status table shows it as "not in this run". Without it, a green nightly would have filed every weekly lane as newly failing (they are `skipped`), and it would have dropped a red weekly lane from #3394 too. The nightly run passes `--scope select-lanes,full-suite,android-launch`.
- **The watchdog window is daily.** `WATCHED` in `check-workflow-liveness.mjs` gives `scheduled-deep-checks.yml` `periodHours: 24` and `maxAgeHours: 30`, derived next to the other entries.

## Decisions and traps

- The issue says "the `--run-ignored` full suite". The only `--run-ignored` run is `bench-perf-gates` in the `bench-slo` lane: perf gates plus the differential fuzz, both of which the issue keeps weekly or out of scope. The lane it names elsewhere (green in #3394 before going nightly) is `full-suite`, so that lane is the one that moved.
- nextest's store dir is `<workspace>/target/nextest`, not under the cargo target dir, so the report path is the same under `cargo llvm-cov nextest`.
- The watchdog also judges the conclusion of the newest scheduled run. A weekly-only lane that is red on Monday now shows as green on Tuesday's nightly, so #3388 can comment on Monday and recover on Tuesday each week while #3394 keeps the lane tracked.
- `full-suite` was still red in #3394 when this landed, so the nightly run is red until it is fixed. That rewrites the issue body and posts no comment.

## Checks run

- `node --test scripts/nextest-flaky-report.test.mjs scripts/file-scheduled-failures.test.mjs scripts/check-workflow-liveness.test.mjs`. The first two are new. Both are red under mutation: dropping `flakyError` / counting `rerunFailure` / skipping the completeness check, and ignoring carried lanes / the missing-scope check / the "not in this run" rows. The reporter test is also red against `HEAD`'s reporter.
- `select-lanes` was simulated in bash for no cron, the weekly cron, the nightly cron and an unknown cron. The reporter was dry-run on #3394's live body with a green nightly, and the action was `close`.
- `prek run actionlint`, `prek run zizmor` and the pre-commit hooks on the changed files. No cargo, and no Actions run.
