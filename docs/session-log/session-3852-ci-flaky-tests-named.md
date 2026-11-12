# Session 3852 — CI: flaky nextest tests named

The first item of #6553: a Rust test that fails once and passes on a `retries` attempt now leaves its name behind. The issue's other three items are not part of this.

## What changed

- `profile.ci` in `src-tauri/.config/nextest.toml` writes a JUnit report to `target/nextest/ci/junit.xml`. All three CI nextest runs (`cargo-tests` shards, `mcp-tests`, the `full-suite-nextest` shards of `scheduled-deep-checks.yml`) run `scripts/nextest-flaky-report.mjs` on it, which lists every test with a `<flakyFailure>` or `<flakyError>` (failed an attempt, then passed) in the job summary, and upload the XML for 30 days.
- A flaky test does not fail the job; a missing or truncated report does. The report is missing only when nextest never ran (the job is already red) or the `junit` config broke, which is the case the report must not read as "no flaky tests".
- The OPEN QUESTION in `nextest.toml` cited closed #3959; it now cites #6553, whose last item (retries off) is the one that resolves it.

## Decisions and traps

- nextest's store dir is `<workspace root>/target/nextest/<profile>` (`make_profile` in nextest-runner), not under the cargo target dir, so the report path is the same under `cargo llvm-cov nextest`, which moves the target dir.
- The element names come from quick-junit's serializer, which writes a passing test's prior failed attempts as `<flakyFailure>` / `<flakyError>` and escapes every text node, so a tag scanner reads the report without an XML parser.
- The nightly cadence (the issue's second item) was built in the same branch and held back: the issue says to go nightly only once the `full-suite` lane is green, and #3394 still tracks it red, so every night would have been red. #6553 keeps that item open.

## Checks run

- `node --test scripts/nextest-flaky-report.test.mjs`: 5 pass; red under mutation for dropping `flakyError`, counting `rerunFailure`, and skipping the completeness and empty-report checks.
- `prek run actionlint`, `prek run zizmor` and the pre-commit hooks on the changed files. No cargo, and no Actions run: the issue's "a deliberately flaky test appears by name in a green run's summary" is still to be shown on CI.
